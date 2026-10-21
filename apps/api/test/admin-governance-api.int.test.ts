import { randomUUID } from 'node:crypto';

import {
  auditLogs,
  platformSettings,
  recordAuditLog,
  vendors,
  type Database,
} from '@hamro-pasal/db';
import {
  adminAuditLogListResponseSchema,
  adminComplianceVendorListResponseSchema,
  panStandingOf,
  feedResponseSchema,
  logisticsSettingsViewSchema,
  panVerificationResponseSchema,
  PLATFORM_SETTINGS_ENTITY_ID,
  type AuditLogView,
} from '@hamro-pasal/shared-types';
import { and, asc, eq } from 'drizzle-orm';
import request from 'supertest';

import { bearer, bodyOf, buildTestApp, errorOf, type TestApp } from './support/http';
import { createUser, createVendor, vendorUserIdOf } from './support/fixtures';

/**
 * Phase 26: the Super Admin's audit trail (read only), the logistics settings and PAN
 * verification, over HTTP on real PostgreSQL.
 */
describe('Admin governance API', () => {
  let testApp: TestApp;
  let db: Database;
  let adminId: string;
  let admin: string;

  const DEFAULT_LOGISTICS = {
    self_delivery_enabled: true,
    platform_fleet_enabled: true,
    platform_delivery_fee_npr: 50,
    free_delivery_above_npr: null,
  };

  const resetLogistics = () => db.update(platformSettings).set(DEFAULT_LOGISTICS);

  beforeAll(async () => {
    testApp = buildTestApp();
    db = testApp.container.db;
    adminId = await createUser(db, 'SUPER_ADMIN');
    admin = bearer(adminId, 'SUPER_ADMIN');
    await resetLogistics();
  });

  afterEach(async () => {
    // Other suites share this database: no test leaves a delivery mode switched off.
    await resetLogistics();
  });

  afterAll(async () => {
    await testApp.container.close();
  });

  const get = (path: string, token: string | null = admin) => {
    const req = request(testApp.app).get(path);
    return token === null ? req : req.set('Authorization', token);
  };

  async function vendorRow(vendorId: string) {
    const [row] = await db.select().from(vendors).where(eq(vendors.id, vendorId));
    if (row === undefined) throw new Error('vendor not found');
    return row;
  }

  /** The stored entries about one record, oldest first. */
  const storedEntries = (entityId: string) =>
    db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.entity_id, entityId))
      .orderBy(asc(auditLogs.occurred_at), asc(auditLogs.id));

  const savePan = (vendorUserId: string, taxId: string) =>
    request(testApp.app)
      .put('/api/vendor/tax-identity')
      .set('Authorization', bearer(vendorUserId, 'VENDOR'))
      .send({ tax_id: taxId, is_vat_registered: false });

  const jobEntry = (vendorId: string, job = 'VENDOR_COMPLIANCE_SWEEP') =>
    db.transaction((tx) =>
      recordAuditLog(tx, {
        actor: { kind: 'SYSTEM', job },
        action: 'VENDOR_SUSPENDED_FOR_COMPLIANCE',
        entityId: vendorId,
        vendorId,
        beforeState: { status: 'LIVE' },
        afterState: { status: 'SUSPENDED_COMPLIANCE' },
      }),
    );

  /**
   * Runs `change` in a transaction that stays open (holding its row locks) while `request` is
   * sent, then commits. The request can only answer correctly if it waited for that commit.
   */
  async function whileUncommitted<T>(
    change: (tx: Parameters<Parameters<Database['transaction']>[0]>[0]) => Promise<unknown>,
    send: () => Promise<T>,
  ): Promise<T> {
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let lockTaken = (): void => undefined;
    const locked = new Promise<void>((resolve) => {
      lockTaken = resolve;
    });
    const first = db.transaction(async (tx) => {
      await change(tx);
      lockTaken();
      await held;
    });
    await locked;
    const second = send();
    await new Promise((resolve) => setTimeout(resolve, 200));
    release();
    await first;
    return second;
  }

  describe('GET /api/admin/audit-logs', () => {
    async function entries(query: Record<string, string>): Promise<AuditLogView[]> {
      const res = await get('/api/admin/audit-logs').query(query);
      expect(res.status).toBe(200);
      return bodyOf(adminAuditLogListResponseSchema, res).entries;
    }

    /** A shop with three entries: an admin's, its own account's, and a job's. */
    async function shopWithHistory() {
      const businessName = `Audit Pasal ${randomUUID()}`;
      const vendorId = await createVendor(db, { businessName });
      const vendorUserId = await vendorUserIdOf(db, vendorId);
      const suspended = await request(testApp.app)
        .post(`/api/admin/vendors/${vendorId}/suspend`)
        .set('Authorization', admin);
      expect(suspended.status).toBe(200);
      expect((await savePan(vendorUserId, '302118845')).status).toBe(200);
      await jobEntry(vendorId);
      return { vendorId, vendorUserId, businessName, requestId: suspended.headers['x-request-id'] };
    }

    it('lists a shop’s entries newest first, with who acted and the stored states', async () => {
      const shop = await shopWithHistory();

      const res = await get('/api/admin/audit-logs').query({ vendor_id: shop.vendorId });

      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
      const body = bodyOf(adminAuditLogListResponseSchema, res);
      expect(body.next_cursor).toBeNull();
      expect(body.entries.map((entry) => entry.action)).toEqual([
        'VENDOR_SUSPENDED_FOR_COMPLIANCE',
        'TAX_IDENTITY_SAVED',
        'VENDOR_SUSPENDED_BY_ADMIN',
      ]);
      const [byJob, byVendor, byAdmin] = body.entries;
      expect(byAdmin).toMatchObject({
        actor_user_id: adminId,
        actor_role: 'SUPER_ADMIN',
        system_actor: null,
        actor_name: 'Test',
        vendor_id: shop.vendorId,
        vendor_name: shop.businessName,
        entity_type: 'vendor',
        entity_id: shop.vendorId,
        request_id: shop.requestId,
      });
      // A vendor is named by its shop, a job by its own name.
      expect(byVendor).toMatchObject({
        actor_user_id: shop.vendorUserId,
        actor_role: 'VENDOR',
        actor_name: shop.businessName,
      });
      expect(byJob).toMatchObject({
        actor_user_id: null,
        actor_role: null,
        system_actor: 'VENDOR_COMPLIANCE_SWEEP',
        actor_name: 'VENDOR_COMPLIANCE_SWEEP',
        request_id: null,
        ip_address: null,
      });

      // The states are the stored JSON, untouched.
      const stored = (await storedEntries(shop.vendorId)).reverse();
      expect(body.entries.map((entry) => entry.id)).toEqual(stored.map((row) => row.id));
      body.entries.forEach((entry, index) => {
        expect(entry.before_state).toEqual(stored[index]?.before_state);
        expect(entry.after_state).toEqual(stored[index]?.after_state);
        expect(entry.occurred_at).toBe(stored[index]?.occurred_at.toISOString());
      });
      expect(byVendor?.before_state).toMatchObject({ tax_id: null });
      expect(byVendor?.after_state).toMatchObject({ tax_id: '302118845' });
    });

    it('filters by actor, by the record an entry is about, by action and by record type', async () => {
      const shop = await shopWithHistory();
      const other = await shopWithHistory();

      const byActor = await entries({ actor_user_id: shop.vendorUserId });
      expect(byActor.map((entry) => entry.action)).toEqual(['TAX_IDENTITY_SAVED']);

      const byTarget = await entries({ entity_id: shop.vendorId });
      expect(byTarget).toHaveLength(3);
      expect(byTarget.every((entry) => entry.entity_id === shop.vendorId)).toBe(true);

      expect(
        (await entries({ entity_id: shop.vendorId, action: 'VENDOR_SUSPENDED_BY_ADMIN' })).map(
          (entry) => entry.actor_user_id,
        ),
      ).toEqual([adminId]);
      // Filters combine: this admin's entries about the other shop only.
      const combined = await entries({ actor_user_id: adminId, vendor_id: other.vendorId });
      expect(combined.map((entry) => [entry.action, entry.vendor_id])).toEqual([
        ['VENDOR_SUSPENDED_BY_ADMIN', other.vendorId],
      ]);
      expect(await entries({ entity_id: shop.vendorId, entity_type: 'vendor' })).toHaveLength(3);
      expect(await entries({ entity_id: shop.vendorId, entity_type: 'pricing_plan' })).toEqual([]);
      expect(await entries({ actor_user_id: randomUUID() })).toEqual([]);
    });

    it('pages with the cursor, without gaps or repeats', async () => {
      const vendorId = await createVendor(db);
      for (let i = 0; i < 5; i += 1) await jobEntry(vendorId);
      const expected = (await storedEntries(vendorId)).reverse().map((row) => row.id);

      const seen: string[] = [];
      let cursor: string | null = null;
      const pageSizes: number[] = [];
      do {
        const res = await get('/api/admin/audit-logs').query({
          entity_id: vendorId,
          limit: '2',
          ...(cursor === null ? {} : { cursor }),
        });
        expect(res.status).toBe(200);
        const body = bodyOf(adminAuditLogListResponseSchema, res);
        pageSizes.push(body.entries.length);
        seen.push(...body.entries.map((entry) => entry.id));
        cursor = body.next_cursor;
      } while (cursor !== null);

      expect(pageSizes).toEqual([2, 2, 1]);
      expect(seen).toEqual(expected);
    });

    it('answers at most 50 entries by default and 100 on request', async () => {
      const unfiltered = bodyOf(
        adminAuditLogListResponseSchema,
        await get('/api/admin/audit-logs'),
      );
      expect(unfiltered.entries.length).toBeLessThanOrEqual(50);
      const times = unfiltered.entries.map((entry) => entry.occurred_at);
      expect(times).toEqual([...times].sort().reverse());
      expect((await get('/api/admin/audit-logs').query({ limit: '100' })).status).toBe(200);
    });

    it('refuses an unknown cursor and malformed queries', async () => {
      const unknown = await get('/api/admin/audit-logs').query({ cursor: randomUUID() });
      expect(unknown.status).toBe(400);
      expect(errorOf(unknown).code).toBe('INVALID_CURSOR');

      for (const query of [
        { limit: '0' },
        { limit: '101' },
        { limit: 'ten' },
        { actor_user_id: 'sarita' },
        { entity_id: 'x' },
        { action: 'drop table' },
        { target_id: randomUUID() },
      ]) {
        const res = await get('/api/admin/audit-logs').query(query);
        expect(res.status).toBe(400);
        expect(errorOf(res).code).toBe('VALIDATION_FAILED');
      }
    });

    it('has no write route of any kind', async () => {
      const vendorId = await createVendor(db);
      const entry = await jobEntry(vendorId);

      for (const call of [
        request(testApp.app).post('/api/admin/audit-logs').send({ action: 'PAN_VERIFIED' }),
        request(testApp.app).put(`/api/admin/audit-logs/${entry.id}`).send({ after_state: {} }),
        request(testApp.app).patch(`/api/admin/audit-logs/${entry.id}`).send({ after_state: {} }),
        request(testApp.app).delete(`/api/admin/audit-logs/${entry.id}`),
        request(testApp.app).delete('/api/admin/audit-logs'),
      ]) {
        const res = await call.set('Authorization', admin);
        expect(res.status).toBe(404);
        expect(errorOf(res).code).toBe('NOT_FOUND');
      }
      expect(await storedEntries(vendorId)).toEqual([entry]);
    });
  });

  describe('logistics settings', () => {
    const put = (body: unknown, token: string | null = admin) => {
      const req = request(testApp.app).put('/api/admin/settings/logistics');
      return (token === null ? req : req.set('Authorization', token)).send(body as object);
    };

    const settingsRow = async () => {
      const [row] = await db.select().from(platformSettings);
      if (row === undefined) throw new Error('platform_settings row is missing');
      return row;
    };

    const logisticsEntries = () => storedEntries(PLATFORM_SETTINGS_ENTITY_ID);

    it('reads the settings and counts the LIVE shops on each mode', async () => {
      const before = bodyOf(
        logisticsSettingsViewSchema,
        await get('/api/admin/settings/logistics'),
      );
      await createVendor(db, { fulfillmentMode: 'SELF_DELIVERY' });
      await createVendor(db, { fulfillmentMode: 'PLATFORM_FLEET' });
      await createVendor(db, { fulfillmentMode: 'PLATFORM_FLEET' });
      // Not LIVE: switching its mode off takes no shop offline.
      await createVendor(db, { fulfillmentMode: 'SELF_DELIVERY', status: 'APPROVED' });

      const res = await get('/api/admin/settings/logistics');

      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
      const after = bodyOf(logisticsSettingsViewSchema, res);
      expect(after).toMatchObject(DEFAULT_LOGISTICS);
      expect(after.self_delivery_vendor_count - before.self_delivery_vendor_count).toBe(1);
      expect(after.platform_fleet_vendor_count - before.platform_fleet_vendor_count).toBe(2);
      expect(after.updated_at).toBe((await settingsRow()).updated_at.toISOString());
    });

    it('sets the platform free-delivery threshold, keeps it when absent, and clears it with null', async () => {
      const set = await put({ ...DEFAULT_LOGISTICS, free_delivery_above_npr: 100 });
      expect(set.status).toBe(200);
      expect(bodyOf(logisticsSettingsViewSchema, set).free_delivery_above_npr).toBe(100);
      expect((await logisticsEntries()).at(-1)?.after_state).toMatchObject({
        free_delivery_above_npr: 100,
      });

      // An older dashboard sends the three settings only: the threshold stays.
      const { free_delivery_above_npr: _omitted, ...withoutThreshold } = DEFAULT_LOGISTICS;
      await put({ ...withoutThreshold, platform_delivery_fee_npr: 60 });
      expect(await settingsRow()).toMatchObject({
        platform_delivery_fee_npr: 60,
        free_delivery_above_npr: 100,
      });

      await put({ ...DEFAULT_LOGISTICS, free_delivery_above_npr: null });
      expect((await settingsRow()).free_delivery_above_npr).toBeNull();

      for (const bad of [0, -5, 10.005, 100_001]) {
        const res = await put({ ...DEFAULT_LOGISTICS, free_delivery_above_npr: bad });
        expect([res.status, errorOf(res).code]).toEqual([400, 'VALIDATION_FAILED']);
      }
    });

    it('saves the three settings and audits them in the same transaction', async () => {
      const entriesBefore = (await logisticsEntries()).length;
      const stampBefore = (await settingsRow()).updated_at;

      const res = await put({
        self_delivery_enabled: true,
        platform_fleet_enabled: false,
        platform_delivery_fee_npr: 79.5,
      });

      expect(res.status).toBe(200);
      const body = bodyOf(logisticsSettingsViewSchema, res);
      expect(body).toMatchObject({
        self_delivery_enabled: true,
        platform_fleet_enabled: false,
        platform_delivery_fee_npr: 79.5,
      });
      const row = await settingsRow();
      expect(row).toMatchObject({
        self_delivery_enabled: true,
        platform_fleet_enabled: false,
        platform_delivery_fee_npr: 79.5,
        // Not its business: the wallet limit is untouched.
        vendor_wallet_suspension_limit_npr: -2000,
      });
      expect(row.updated_at.getTime()).toBeGreaterThan(stampBefore.getTime());
      expect(body.updated_at).toBe(row.updated_at.toISOString());

      const entries = await logisticsEntries();
      expect(entries).toHaveLength(entriesBefore + 1);
      expect(entries.at(-1)).toMatchObject({
        action: 'LOGISTICS_SETTINGS_CHANGED',
        actor_user_id: adminId,
        actor_role: 'SUPER_ADMIN',
        system_actor: null,
        vendor_id: null,
        entity_type: 'platform_settings',
        before_state: DEFAULT_LOGISTICS,
        after_state: {
          self_delivery_enabled: true,
          platform_fleet_enabled: false,
          platform_delivery_fee_npr: 79.5,
        },
        request_id: res.headers['x-request-id'],
      });

      // And it is what the audit log route shows for the platform's settings.
      const listed = bodyOf(
        adminAuditLogListResponseSchema,
        await get('/api/admin/audit-logs').query({ entity_id: PLATFORM_SETTINGS_ENTITY_ID }),
      );
      expect(listed.entries[0]).toMatchObject({
        id: entries.at(-1)?.id,
        actor_name: 'Test',
        vendor_name: null,
        after_state: { platform_delivery_fee_npr: 79.5 },
      });
    });

    it('changes and records nothing when the stored settings are saved again', async () => {
      const entriesBefore = (await logisticsEntries()).length;
      const stampBefore = (await settingsRow()).updated_at;

      const res = await put(DEFAULT_LOGISTICS);

      expect(res.status).toBe(200);
      expect(bodyOf(logisticsSettingsViewSchema, res)).toMatchObject(DEFAULT_LOGISTICS);
      expect((await settingsRow()).updated_at).toEqual(stampBefore);
      expect(await logisticsEntries()).toHaveLength(entriesBefore);
    });

    it('accepts both modes off, the Emergency Stop, and shops return when a mode is back', async () => {
      const vendorId = await createVendor(db, { businessName: `Stop ${randomUUID()}` });
      const feed = async () => {
        const body = bodyOf(
          feedResponseSchema,
          await request(testApp.app).get('/api/vendors').query({ lat: '27.7154', lng: '85.3123' }),
        );
        return [...body.serviceable, ...body.explore_further].map((entry) => entry.vendor.id);
      };
      const statusBefore = (await vendorRow(vendorId)).status;

      const stopped = await put({
        ...DEFAULT_LOGISTICS,
        self_delivery_enabled: false,
        platform_fleet_enabled: false,
      });

      expect(stopped.status).toBe(200);
      expect(await feed()).toEqual([]);
      // Derived, not written: the shop's own row is untouched.
      expect((await vendorRow(vendorId)).status).toBe(statusBefore);

      expect((await put(DEFAULT_LOGISTICS)).status).toBe(200);
      expect((await feed()).length).toBeGreaterThan(0);
      expect((await logisticsEntries()).slice(-2).map((entry) => entry.after_state)).toEqual([
        { ...DEFAULT_LOGISTICS, self_delivery_enabled: false, platform_fleet_enabled: false },
        DEFAULT_LOGISTICS,
      ]);
    });

    it('writes one entry when the same change arrives five times at once', async () => {
      const entriesBefore = (await logisticsEntries()).length;
      const change = { ...DEFAULT_LOGISTICS, platform_delivery_fee_npr: 65 };

      const results = await Promise.all([1, 2, 3, 4, 5].map(() => put(change)));

      expect(results.map((res) => res.status)).toEqual([200, 200, 200, 200, 200]);
      expect(await logisticsEntries()).toHaveLength(entriesBefore + 1);
    });

    it('waits for a change holding the settings row, then sees its result', async () => {
      const entriesBefore = (await logisticsEntries()).length;
      const change = { ...DEFAULT_LOGISTICS, platform_delivery_fee_npr: 65 };

      const res = await whileUncommitted(
        (tx) => tx.update(platformSettings).set({ platform_delivery_fee_npr: 65 }),
        () => put(change).then((answer) => answer),
      );

      // Without the lock it would read the old fee and audit a change that was already made.
      expect(res.status).toBe(200);
      expect(bodyOf(logisticsSettingsViewSchema, res).platform_delivery_fee_npr).toBe(65);
      expect(await logisticsEntries()).toHaveLength(entriesBefore);
    });

    it('refuses invalid bodies and stores nothing', async () => {
      const entriesBefore = (await logisticsEntries()).length;
      for (const body of [
        {},
        { self_delivery_enabled: true, platform_fleet_enabled: true },
        { ...DEFAULT_LOGISTICS, platform_delivery_fee_npr: -1 },
        { ...DEFAULT_LOGISTICS, platform_delivery_fee_npr: 10_000.01 },
        { ...DEFAULT_LOGISTICS, platform_delivery_fee_npr: 49.999 },
        { ...DEFAULT_LOGISTICS, platform_delivery_fee_npr: '50' },
        { ...DEFAULT_LOGISTICS, self_delivery_enabled: 'yes' },
        { ...DEFAULT_LOGISTICS, vendor_wallet_suspension_limit_npr: 0 },
        { ...DEFAULT_LOGISTICS, platform_delivery_enabled: true },
      ]) {
        const res = await put(body);
        expect(res.status).toBe(400);
        expect(errorOf(res).code).toBe('VALIDATION_FAILED');
      }
      expect(await settingsRow()).toMatchObject(DEFAULT_LOGISTICS);
      expect(await logisticsEntries()).toHaveLength(entriesBefore);
    });
  });

  describe('POST /api/admin/vendors/:id/pan-verification', () => {
    const verify = (vendorId: string, token: string | null = admin) => {
      const req = request(testApp.app).post(`/api/admin/vendors/${vendorId}/pan-verification`);
      return token === null ? req : req.set('Authorization', token);
    };

    async function vendorWithPan(taxId = '302118845') {
      const vendorId = await createVendor(db);
      await db
        .update(vendors)
        .set({ tax_id: taxId, pan_document_url: `kyc/pan/${vendorId}/${randomUUID()}.webp` })
        .where(eq(vendors.id, vendorId));
      return vendorId;
    }

    const verifiedEntries = (vendorId: string) =>
      db
        .select()
        .from(auditLogs)
        .where(and(eq(auditLogs.entity_id, vendorId), eq(auditLogs.action, 'PAN_VERIFIED')));

    it('stamps the time and the admin, audits it, and leaves the status alone', async () => {
      const vendorId = await vendorWithPan();

      const res = await verify(vendorId);

      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
      const { vendor } = bodyOf(panVerificationResponseSchema, res);
      const row = await vendorRow(vendorId);
      expect(row.pan_verified_at).toBeInstanceOf(Date);
      expect(row.pan_verified_by_user_id).toBe(adminId);
      expect(row.status).toBe('LIVE');
      expect(vendor).toMatchObject({
        id: vendorId,
        status: 'LIVE',
        restore_status: null,
        compliance_suspended_at: null,
        tax_id: '302118845',
        pan_verified_at: row.pan_verified_at?.toISOString(),
      });

      const entries = await storedEntries(vendorId);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        action: 'PAN_VERIFIED',
        actor_user_id: adminId,
        actor_role: 'SUPER_ADMIN',
        entity_type: 'vendor',
        vendor_id: vendorId,
        before_state: {
          tax_id: '302118845',
          pan_verified_at: null,
          pan_verified_by_user_id: null,
        },
        after_state: {
          tax_id: '302118845',
          pan_verified_at: row.pan_verified_at?.toISOString(),
          pan_verified_by_user_id: adminId,
        },
        request_id: res.headers['x-request-id'],
      });
    });

    it('keeps the first stamp on a repeat, also by another admin, and records nothing more', async () => {
      const vendorId = await vendorWithPan();
      const first = bodyOf(panVerificationResponseSchema, await verify(vendorId)).vendor;
      const otherAdmin = bearer(await createUser(db, 'SUPER_ADMIN'), 'SUPER_ADMIN');

      for (const token of [admin, otherAdmin]) {
        const res = await verify(vendorId, token);
        expect(res.status).toBe(200);
        expect(bodyOf(panVerificationResponseSchema, res).vendor).toEqual(first);
      }

      expect((await vendorRow(vendorId)).pan_verified_by_user_id).toBe(adminId);
      expect(await verifiedEntries(vendorId)).toHaveLength(1);
    });

    it('verifies once when five requests arrive together', async () => {
      const vendorId = await vendorWithPan();

      const results = await Promise.all([1, 2, 3, 4, 5].map(() => verify(vendorId)));

      expect(results.map((res) => res.status)).toEqual([200, 200, 200, 200, 200]);
      const stamps = results.map(
        (res) => bodyOf(panVerificationResponseSchema, res).vendor.pan_verified_at,
      );
      expect(new Set(stamps).size).toBe(1);
      expect(await verifiedEntries(vendorId)).toHaveLength(1);
    });

    it('waits for a verification holding the vendor row, and keeps that one', async () => {
      const vendorId = await vendorWithPan();
      const otherAdminId = await createUser(db, 'SUPER_ADMIN');

      const res = await whileUncommitted(
        (tx) =>
          tx
            .update(vendors)
            .set({ pan_verified_at: new Date(), pan_verified_by_user_id: otherAdminId })
            .where(eq(vendors.id, vendorId)),
        () => verify(vendorId).then((answer) => answer),
      );

      // Without the lock it would read "unverified" and stamp over the other admin's check.
      expect(res.status).toBe(200);
      expect((await vendorRow(vendorId)).pan_verified_by_user_id).toBe(otherAdminId);
      expect(await verifiedEntries(vendorId)).toEqual([]);
    });

    it('never lands on a PAN that was replaced first', async () => {
      const vendorId = await vendorWithPan();
      const vendorUserId = await vendorUserIdOf(db, vendorId);

      // The vendor's PAN change is committed while the verification waits on the row.
      const res = await whileUncommitted(
        (tx) => tx.update(vendors).set({ tax_id: '609988776' }).where(eq(vendors.id, vendorId)),
        () => verify(vendorId).then((answer) => answer),
      );

      expect(res.status).toBe(200);
      const [entry] = await verifiedEntries(vendorId);
      // What was verified is the PAN on file at that moment, and the entry says so.
      expect(bodyOf(panVerificationResponseSchema, res).vendor.tax_id).toBe('609988776');
      expect(entry?.before_state).toMatchObject({ tax_id: '609988776' });
      expect((await savePan(vendorUserId, '609988776')).status).toBe(200);
    });

    it('answers 409 PAN_MISSING for a shop without a PAN and stores nothing', async () => {
      const vendorId = await createVendor(db);

      const res = await verify(vendorId);

      expect(res.status).toBe(409);
      expect(errorOf(res).code).toBe('PAN_MISSING');
      expect(await vendorRow(vendorId)).toMatchObject({
        pan_verified_at: null,
        pan_verified_by_user_id: null,
      });
      expect(await storedEntries(vendorId)).toEqual([]);
    });

    it('answers 422 DOCUMENT_MISSING for a PAN without an uploaded document, storing nothing', async () => {
      const vendorId = await createVendor(db);
      await db.update(vendors).set({ tax_id: '302118845' }).where(eq(vendors.id, vendorId));

      const res = await verify(vendorId);

      expect(res.status).toBe(422);
      expect(errorOf(res)).toMatchObject({
        code: 'DOCUMENT_MISSING',
        details: { vendor_id: vendorId },
      });
      expect(await vendorRow(vendorId)).toMatchObject({
        pan_verified_at: null,
        pan_verified_by_user_id: null,
      });
      expect(await storedEntries(vendorId)).toEqual([]);

      // The document arrives: the same request now verifies.
      await db
        .update(vendors)
        .set({ pan_document_url: `kyc/pan/${vendorId}/${randomUUID()}.webp` })
        .where(eq(vendors.id, vendorId));
      expect((await verify(vendorId)).status).toBe(200);
    });

    it('never confirms a shop that is marked verified with no document on file', async () => {
      // Only a seeded or hand-edited row can be in this state.
      const vendorId = await createVendor(db);
      await db
        .update(vendors)
        .set({ tax_id: '302118845', pan_verified_at: new Date(), pan_verified_by_user_id: adminId })
        .where(eq(vendors.id, vendorId));

      const res = await verify(vendorId);

      expect(res.status).toBe(422);
      expect(errorOf(res).code).toBe('DOCUMENT_MISSING');
      expect(await storedEntries(vendorId)).toEqual([]);
    });

    it('cannot lift a compliance suspension', async () => {
      const vendorId = await createVendor(db);
      await db
        .update(vendors)
        .set({ status: 'SUSPENDED_COMPLIANCE', status_before_compliance_suspension: 'LIVE' })
        .where(eq(vendors.id, vendorId));

      const res = await verify(vendorId);

      expect(res.status).toBe(409);
      expect(errorOf(res).code).toBe('PAN_MISSING');
      expect(await vendorRow(vendorId)).toMatchObject({
        status: 'SUSPENDED_COMPLIANCE',
        status_before_compliance_suspension: 'LIVE',
        pan_verified_at: null,
      });
    });

    it('is cleared by a changed PAN, which takes the shop offline until verified again (2026-10-20)', async () => {
      const vendorId = await vendorWithPan();
      const vendorUserId = await vendorUserIdOf(db, vendorId);
      const first = bodyOf(panVerificationResponseSchema, await verify(vendorId)).vendor;

      expect((await savePan(vendorUserId, '609988776')).status).toBe(200);
      const cleared = await vendorRow(vendorId);
      expect(cleared).toMatchObject({
        pan_verified_at: null,
        status: 'SUSPENDED_COMPLIANCE',
        status_before_compliance_suspension: 'LIVE',
      });

      // The document was the old number's: it went with it, and nothing can be verified yet.
      expect(cleared.pan_document_url).toBeNull();
      const early = await verify(vendorId);
      expect(early.status).toBe(422);
      expect(errorOf(early).code).toBe('DOCUMENT_MISSING');
      await db
        .update(vendors)
        .set({ pan_document_url: `kyc/pan/${vendorId}/${randomUUID()}.webp` })
        .where(eq(vendors.id, vendorId));

      const res = await verify(vendorId);

      expect(res.status).toBe(200);
      const second = bodyOf(panVerificationResponseSchema, res).vendor;
      expect(second.tax_id).toBe('609988776');
      expect(second.pan_verified_at).not.toBeNull();
      expect(second.pan_verified_at).not.toBe(first.pan_verified_at);
      // The new verification is what brings the shop back.
      expect(second).toMatchObject({ status: 'LIVE', restore_status: null });
      const verified = await verifiedEntries(vendorId);
      expect(verified.map((entry) => entry.after_state.tax_id).sort()).toEqual([
        '302118845',
        '609988776',
      ]);
      expect((await storedEntries(vendorId)).map((entry) => entry.action).sort()).toEqual([
        'PAN_DOCUMENT_REMOVED',
        'PAN_VERIFICATION_CLEARED',
        'PAN_VERIFIED',
        'PAN_VERIFIED',
        'TAX_IDENTITY_SAVED',
        'VENDOR_SUSPENDED_FOR_COMPLIANCE',
      ]);
    });

    it('lifts a compliance suspension that lies under an admin one, and leaves that one in place', async () => {
      const vendorId = await vendorWithPan();
      await jobEntry(vendorId);
      await db
        .update(vendors)
        .set({
          status: 'SUSPENDED',
          status_before_compliance_suspension: 'APPROVED',
          status_before_admin_suspension: 'SUSPENDED_COMPLIANCE',
        })
        .where(eq(vendors.id, vendorId));

      const res = await verify(vendorId);

      expect(res.status).toBe(200);
      expect(bodyOf(panVerificationResponseSchema, res).vendor).toMatchObject({
        status: 'SUSPENDED',
        restore_status: null,
        compliance_suspended_at: null,
      });
      // The admin's Restore now returns the shop to what it was before the compliance suspension.
      expect(await vendorRow(vendorId)).toMatchObject({
        status: 'SUSPENDED',
        status_before_compliance_suspension: null,
        status_before_admin_suspension: 'APPROVED',
      });
    });

    it('answers 404 for an unknown vendor and 400 for a malformed id', async () => {
      const unknown = await verify(randomUUID());
      expect(unknown.status).toBe(404);
      expect(errorOf(unknown).code).toBe('VENDOR_NOT_FOUND');
      const malformed = await verify('not-a-uuid');
      expect(malformed.status).toBe(400);
      expect(errorOf(malformed).code).toBe('VALIDATION_FAILED');
    });
  });

  describe('GET /api/admin/compliance/vendors', () => {
    it('lists every vendor grouped by PAN standing, worst first', async () => {
      const tag = randomUUID();
      const make = async (label: string) => createVendor(db, { businessName: `${label} ${tag}` });
      const verified = await make('A verified');
      await db
        .update(vendors)
        .set({ tax_id: '302118845', pan_document_url: `kyc/pan/${verified}/${randomUUID()}.webp` })
        .where(eq(vendors.id, verified));
      await request(testApp.app)
        .post(`/api/admin/vendors/${verified}/pan-verification`)
        .set('Authorization', admin);
      const unverified = await make('B unverified');
      await db
        .update(vendors)
        .set({ tax_id: '609988776', legal_name: 'B Traders Pvt. Ltd.', is_vat_registered: true })
        .where(eq(vendors.id, unverified));
      const missing = await make('C missing');
      const suspendedLater = await make('D suspended later');
      const suspendedFirst = await make('E suspended first');
      for (const vendorId of [suspendedFirst, suspendedLater]) {
        await jobEntry(vendorId);
        await db
          .update(vendors)
          .set({ status: 'SUSPENDED_COMPLIANCE', status_before_compliance_suspension: 'LIVE' })
          .where(eq(vendors.id, vendorId));
      }

      const res = await get('/api/admin/compliance/vendors');

      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
      const all = bodyOf(adminComplianceVendorListResponseSchema, res).vendors;
      // The whole list is in standing order.
      const ranks = all.map((vendor) =>
        ['SUSPENDED', 'MISSING', 'UNVERIFIED', 'VERIFIED'].indexOf(panStandingOf(vendor)),
      );
      expect(ranks).toEqual([...ranks].sort((a, b) => a - b));

      const mine = all.filter((vendor) => vendor.business_name.endsWith(tag));
      // Suspended shops: the longest offline first. Then missing, awaiting verification, verified.
      expect(mine.map((vendor) => vendor.id)).toEqual([
        suspendedFirst,
        suspendedLater,
        missing,
        unverified,
        verified,
      ]);
      expect(mine.map(panStandingOf)).toEqual([
        'SUSPENDED',
        'SUSPENDED',
        'MISSING',
        'UNVERIFIED',
        'VERIFIED',
      ]);
      expect(mine[0]).toMatchObject({
        status: 'SUSPENDED_COMPLIANCE',
        restore_status: 'LIVE',
        tax_id: null,
        pan_verified_at: null,
      });
      expect(mine[0]?.compliance_suspended_at).not.toBeNull();
      expect(mine[2]).toMatchObject({
        status: 'LIVE',
        restore_status: null,
        compliance_suspended_at: null,
        tax_id: null,
      });
      expect(mine[3]).toMatchObject({
        tax_id: '609988776',
        legal_name: 'B Traders Pvt. Ltd.',
        is_vat_registered: true,
        pan_verified_at: null,
        phone: '+9779800000000',
      });
      expect(mine[4]?.pan_verified_at).not.toBeNull();
    });

    it('moves a shop to Verified once its PAN is verified', async () => {
      const vendorId = await createVendor(db);
      await db
        .update(vendors)
        .set({ tax_id: '302118845', pan_document_url: `kyc/pan/${vendorId}/${randomUUID()}.webp` })
        .where(eq(vendors.id, vendorId));
      const standing = async () => {
        const body = bodyOf(
          adminComplianceVendorListResponseSchema,
          await get('/api/admin/compliance/vendors'),
        );
        const vendor = body.vendors.find((row) => row.id === vendorId);
        if (vendor === undefined) throw new Error('vendor not listed');
        return panStandingOf(vendor);
      };

      expect(await standing()).toBe('UNVERIFIED');
      await request(testApp.app)
        .post(`/api/admin/vendors/${vendorId}/pan-verification`)
        .set('Authorization', admin);
      expect(await standing()).toBe('VERIFIED');
    });
  });

  it('serves Super Admins only', async () => {
    const vendorId = await createVendor(db);
    await db.update(vendors).set({ tax_id: '302118845' }).where(eq(vendors.id, vendorId));
    const calls = [
      () => request(testApp.app).get('/api/admin/audit-logs'),
      () => request(testApp.app).get('/api/admin/settings/logistics'),
      () => request(testApp.app).get('/api/admin/compliance/vendors'),
      () =>
        request(testApp.app)
          .put('/api/admin/settings/logistics')
          .send({ ...DEFAULT_LOGISTICS, platform_fleet_enabled: false }),
      () => request(testApp.app).post(`/api/admin/vendors/${vendorId}/pan-verification`),
    ];
    const tokens = [
      bearer(await createUser(db), 'CUSTOMER'),
      // The shop itself cannot verify its own PAN.
      bearer(await vendorUserIdOf(db, vendorId), 'VENDOR'),
      bearer(await createUser(db, 'DRIVER'), 'DRIVER'),
    ];
    for (const call of calls) {
      expect((await call()).status).toBe(401);
      for (const token of tokens) {
        const res = await call().set('Authorization', token);
        expect(res.status).toBe(403);
        expect(errorOf(res).code).toBe('FORBIDDEN');
      }
    }
    expect((await vendorRow(vendorId)).pan_verified_at).toBeNull();
    const [settings] = await db.select().from(platformSettings);
    expect(settings).toMatchObject(DEFAULT_LOGISTICS);
  });
});
