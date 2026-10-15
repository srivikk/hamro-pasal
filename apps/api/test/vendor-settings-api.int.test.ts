import { auditLogs, platformSettings, vendors, type Database } from '@hamro-pasal/db';
import {
  auditLogSchema,
  deliverySettingsResponseSchema,
  taxIdentityResponseSchema,
  PALIKAS,
  type UserRole,
} from '@hamro-pasal/shared-types';
import { asc, eq, sql } from 'drizzle-orm';
import request from 'supertest';

import { createUser, createVendor, vendorUserIdOf } from './support/fixtures';
import { bearer, bodyOf, buildTestApp, errorOf, type TestApp } from './support/http';

/**
 * Phase 25: the vendor's own settings on real PostgreSQL. PUT /api/vendor/tax-identity saves the
 * PAN and lifts a compliance suspension in one transaction; GET / PUT /api/vendor/delivery-settings
 * hold the delivery mode, scope tier and charges. Every change writes its audit_logs entry in the
 * same transaction.
 */
describe('Vendor settings API', () => {
  let t: TestApp;
  let db: Database;
  let adminId: string;

  beforeAll(async () => {
    t = buildTestApp();
    db = t.container.db;
    adminId = await createUser(db, 'SUPER_ADMIN');
  });

  afterEach(async () => {
    // Other suites share this database: leave the platform switches as the migration set them.
    await db
      .update(platformSettings)
      .set({ self_delivery_enabled: true, platform_fleet_enabled: true });
  });

  afterAll(async () => {
    await t.container.close();
  });

  async function shop(options: Parameters<typeof createVendor>[1] = {}) {
    const vendorId = await createVendor(db, options);
    const userId = await vendorUserIdOf(db, vendorId);
    return { vendorId, userId, token: bearer(userId, 'VENDOR') };
  }

  const vendorRow = async (vendorId: string) => {
    const [row] = await db.select().from(vendors).where(eq(vendors.id, vendorId));
    if (row === undefined) throw new Error('vendor not found');
    return row;
  };

  const auditEntries = (vendorId: string) =>
    db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.entity_id, vendorId))
      .orderBy(asc(auditLogs.occurred_at));

  /** What the compliance sweep will do: a LIVE shop without a PAN goes offline. */
  const sweep = (vendorId: string) =>
    db.execute(
      sql`UPDATE vendors SET status = 'SUSPENDED_COMPLIANCE', status_before_compliance_suspension = status
          WHERE id = ${vendorId}`,
    );

  const verifyPan = (vendorId: string) =>
    db
      .update(vendors)
      .set({ pan_verified_at: sql`now()`, pan_verified_by_user_id: adminId })
      .where(eq(vendors.id, vendorId));

  describe('PUT /api/vendor/tax-identity', () => {
    const save = (
      token: string,
      body: unknown = { tax_id: '302118845', is_vat_registered: false },
    ) =>
      request(t.app)
        .put('/api/vendor/tax-identity')
        .set('authorization', token)
        .send(body as object);

    it('saves the PAN of a LIVE shop and audits it, without touching its status', async () => {
      const { vendorId, userId, token } = await shop();

      const res = await save(token, {
        tax_id: '302118845',
        is_vat_registered: true,
        legal_name: '  Thamel Kirana Pasal Pvt. Ltd. ',
        registered_address: 'Thamel Marg, Kathmandu-26',
      });

      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(bodyOf(taxIdentityResponseSchema, res)).toEqual({
        vendor_id: vendorId,
        tax_id: '302118845',
        is_vat_registered: true,
        legal_name: 'Thamel Kirana Pasal Pvt. Ltd.',
        registered_address: 'Thamel Marg, Kathmandu-26',
        status: 'LIVE',
        compliance_suspension_lifted: false,
        pan_verified_at: null,
        waiting_invoices_issued: 0,
        pan_document_removed: false,
        has_pan_document: false,
      });
      expect(await vendorRow(vendorId)).toMatchObject({
        tax_id: '302118845',
        is_vat_registered: true,
        status: 'LIVE',
      });

      const entries = await auditEntries(vendorId);
      expect(entries).toHaveLength(1);
      expect(auditLogSchema.parse(entries[0])).toEqual(entries[0]);
      expect(entries[0]).toMatchObject({
        action: 'TAX_IDENTITY_SAVED',
        entity_type: 'vendor',
        actor_user_id: userId,
        actor_role: 'VENDOR',
        vendor_id: vendorId,
        before_state: { tax_id: null, is_vat_registered: false, status: 'LIVE' },
        after_state: {
          tax_id: '302118845',
          is_vat_registered: true,
          legal_name: 'Thamel Kirana Pasal Pvt. Ltd.',
          status: 'LIVE',
          pan_verified_at: null,
        },
        request_id: res.headers['x-request-id'],
      });
    });

    it('lifts a compliance suspension in the same transaction, back to the status it had', async () => {
      for (const status of ['LIVE', 'APPROVED'] as const) {
        const { vendorId, token } = await shop({ status });
        await sweep(vendorId);
        expect((await vendorRow(vendorId)).status).toBe('SUSPENDED_COMPLIANCE');

        const res = await save(token);

        expect(res.status).toBe(200);
        expect(bodyOf(taxIdentityResponseSchema, res)).toMatchObject({
          status,
          compliance_suspension_lifted: true,
        });
        expect(await vendorRow(vendorId)).toMatchObject({
          status,
          status_before_compliance_suspension: null,
          tax_id: '302118845',
        });
        const [entry] = await auditEntries(vendorId);
        expect(entry).toMatchObject({
          action: 'TAX_IDENTITY_SAVED',
          before_state: { status: 'SUSPENDED_COMPLIANCE', tax_id: null },
          after_state: { status, tax_id: '302118845' },
        });
      }
    });

    it('does not let an admin Restore lift a compliance suspension', async () => {
      const { vendorId } = await shop();
      await sweep(vendorId);

      const res = await request(t.app)
        .post(`/api/admin/vendors/${vendorId}/restore`)
        .set('authorization', bearer(adminId, 'SUPER_ADMIN'));

      expect(res.status).toBe(409);
      expect(errorOf(res).code).toBe('VENDOR_STATUS_CONFLICT');
      expect((await vendorRow(vendorId)).status).toBe('SUSPENDED_COMPLIANCE');
      expect(await auditEntries(vendorId)).toEqual([]);
    });

    it('keeps a debt or admin suspension, but makes it restore to the real status', async () => {
      // A shop swept for compliance and then suspended by an admin on top of it.
      const { vendorId, token } = await shop();
      await sweep(vendorId);
      const admin = bearer(adminId, 'SUPER_ADMIN');
      expect(
        (
          await request(t.app)
            .post(`/api/admin/vendors/${vendorId}/suspend`)
            .set('authorization', admin)
        ).status,
      ).toBe(200);
      expect(await vendorRow(vendorId)).toMatchObject({
        status: 'SUSPENDED',
        status_before_admin_suspension: 'SUSPENDED_COMPLIANCE',
        status_before_compliance_suspension: 'LIVE',
      });

      // The PAN never lifts the admin's suspension...
      const res = await save(token);
      expect(bodyOf(taxIdentityResponseSchema, res)).toMatchObject({
        status: 'SUSPENDED',
        compliance_suspension_lifted: true,
      });
      expect(await vendorRow(vendorId)).toMatchObject({
        status: 'SUSPENDED',
        status_before_admin_suspension: 'LIVE',
        status_before_compliance_suspension: null,
      });

      // ...and the admin's Restore now returns the shop to LIVE, not to a compliance suspension.
      const restored = await request(t.app)
        .post(`/api/admin/vendors/${vendorId}/restore`)
        .set('authorization', admin);
      expect(restored.status).toBe(200);
      expect((await vendorRow(vendorId)).status).toBe('LIVE');
    });

    it('clears the verification when the PAN changes, and audits the freeze', async () => {
      const { vendorId, token } = await shop();
      await save(token);
      await verifyPan(vendorId);

      const res = await save(token, { tax_id: '609871234', is_vat_registered: false });

      expect(res.status).toBe(200);
      expect(bodyOf(taxIdentityResponseSchema, res)).toMatchObject({
        tax_id: '609871234',
        status: 'LIVE',
        pan_verified_at: null,
      });
      expect(await vendorRow(vendorId)).toMatchObject({
        tax_id: '609871234',
        pan_verified_at: null,
        pan_verified_by_user_id: null,
        status: 'LIVE',
      });
      const actions = (await auditEntries(vendorId)).map((entry) => entry.action);
      expect(actions).toEqual([
        'TAX_IDENTITY_SAVED',
        'TAX_IDENTITY_SAVED',
        'PAN_VERIFICATION_CLEARED',
      ]);
      const cleared = (await auditEntries(vendorId)).at(-1);
      expect(cleared).toMatchObject({
        before_state: { tax_id: '302118845', pan_verified_by_user_id: adminId },
        after_state: { tax_id: '609871234', pan_verified_at: null },
      });
      expect(cleared?.before_state?.pan_verified_at).toEqual(expect.any(String));
    });

    it('keeps the verification when the same PAN is saved with other details', async () => {
      const { vendorId, token } = await shop();
      await save(token);
      await verifyPan(vendorId);

      const res = await save(token, { tax_id: '302118845', is_vat_registered: true });

      expect(bodyOf(taxIdentityResponseSchema, res).pan_verified_at).toEqual(expect.any(String));
      expect((await vendorRow(vendorId)).pan_verified_by_user_id).toBe(adminId);
      expect((await auditEntries(vendorId)).map((entry) => entry.action)).toEqual([
        'TAX_IDENTITY_SAVED',
        'TAX_IDENTITY_SAVED',
      ]);
    });

    it('changes and records nothing for a repeat, and keeps the name when it is omitted', async () => {
      const { vendorId, token } = await shop();
      const body = { tax_id: '302118845', is_vat_registered: false, legal_name: 'Thamel Kirana' };
      const first = await save(token, body);
      const updatedAt = (await vendorRow(vendorId)).updated_at;

      const repeat = await save(token, { tax_id: '302118845', is_vat_registered: false });

      expect(repeat.status).toBe(200);
      expect(bodyOf(taxIdentityResponseSchema, repeat)).toEqual(
        bodyOf(taxIdentityResponseSchema, first),
      );
      expect(await vendorRow(vendorId)).toMatchObject({
        legal_name: 'Thamel Kirana',
        updated_at: updatedAt,
      });
      expect(await auditEntries(vendorId)).toHaveLength(1);

      // null clears it.
      await save(token, { ...body, legal_name: null });
      expect((await vendorRow(vendorId)).legal_name).toBeNull();
    });

    it('saves once when the same PAN is sent 5 times at the same moment', async () => {
      const { vendorId, token } = await shop();
      await sweep(vendorId);

      const responses = await Promise.all(Array.from({ length: 5 }, () => save(token)));

      expect(responses.map((res) => res.status)).toEqual([200, 200, 200, 200, 200]);
      expect(
        responses.filter(
          (res) => bodyOf(taxIdentityResponseSchema, res).compliance_suspension_lifted,
        ),
      ).toHaveLength(1);
      expect((await vendorRow(vendorId)).status).toBe('LIVE');
      expect(await auditEntries(vendorId)).toHaveLength(1);
    });

    it('refuses anything but nine digits, and unknown keys, storing nothing', async () => {
      const { vendorId, token } = await shop();
      await sweep(vendorId);
      for (const body of [
        { tax_id: '30211884', is_vat_registered: false },
        { tax_id: '30211884A', is_vat_registered: false },
        { tax_id: '302118845' },
        { tax_id: '302118845', is_vat_registered: false, status: 'LIVE' },
        {
          tax_id: '302118845',
          is_vat_registered: false,
          pan_verified_at: '2026-10-07T00:00:00.000Z',
        },
        {},
      ]) {
        const res = await save(token, body);
        expect(res.status).toBe(400);
        expect(errorOf(res).code).toBe('VALIDATION_FAILED');
      }
      expect(await vendorRow(vendorId)).toMatchObject({
        tax_id: null,
        status: 'SUSPENDED_COMPLIANCE',
      });
      expect(await auditEntries(vendorId)).toEqual([]);
    });

    it('only ever touches the caller’s own shop', async () => {
      const mine = await shop();
      const other = await shop();
      await save(mine.token);
      expect((await vendorRow(other.vendorId)).tax_id).toBeNull();
      expect(await auditEntries(other.vendorId)).toEqual([]);
    });

    it('needs a vendor with a shop', async () => {
      expect((await request(t.app).put('/api/vendor/tax-identity').send({})).status).toBe(401);
      for (const role of ['CUSTOMER', 'DRIVER', 'SUPER_ADMIN'] as UserRole[]) {
        const res = await save(bearer(await createUser(db, role), role));
        expect(res.status).toBe(403);
      }
      const shopless = await save(bearer(await createUser(db, 'VENDOR'), 'VENDOR'));
      expect(shopless.status).toBe(404);
      expect(errorOf(shopless).code).toBe('VENDOR_NOT_FOUND');
    });
  });

  describe('GET /api/vendor/delivery-settings', () => {
    it('returns the shop’s settings and what the platform allows', async () => {
      const { vendorId, token } = await shop({ baseDeliveryFee: 50, radiusKm: 5 });

      const res = await request(t.app)
        .get('/api/vendor/delivery-settings')
        .set('authorization', token);

      expect(res.status).toBe(200);
      expect(bodyOf(deliverySettingsResponseSchema, res)).toEqual({
        vendor_id: vendorId,
        fulfillment_mode: 'SELF_DELIVERY',
        delivery_scope: 'RADIUS_BOUND',
        radius_km: 5,
        serviceable_palikas: ['Kathmandu Metropolitan City'],
        municipality_palika_string: 'Kathmandu Metropolitan City',
        base_delivery_fee_npr: 50,
        delivery_fee_per_km_npr: 0,
        min_order_value: 0,
        free_delivery_above_npr: null,
        platform: {
          self_delivery_enabled: true,
          platform_fleet_enabled: true,
          platform_delivery_fee_npr: 50,
        },
        fulfillment_mode_enabled: true,
      });
    });

    it('says when the shop’s own mode is switched off (forced Offline, derived)', async () => {
      const { vendorId, token } = await shop();
      await db.update(platformSettings).set({ self_delivery_enabled: false });

      const body = bodyOf(
        deliverySettingsResponseSchema,
        await request(t.app).get('/api/vendor/delivery-settings').set('authorization', token),
      );

      expect(body.fulfillment_mode_enabled).toBe(false);
      expect(body.platform.self_delivery_enabled).toBe(false);
      // Nothing is written to the shop: it comes back by itself when the switch does.
      expect(await vendorRow(vendorId)).toMatchObject({
        status: 'LIVE',
        fulfillment_mode: 'SELF_DELIVERY',
      });
    });
  });

  describe('PUT /api/vendor/delivery-settings', () => {
    const radius = {
      fulfillment_mode: 'SELF_DELIVERY',
      delivery_scope: 'RADIUS_BOUND',
      radius_km: 7.5,
      serviceable_palikas: [],
      base_delivery_fee_npr: 40,
      delivery_fee_per_km_npr: 10,
      free_delivery_above_npr: 1500,
    };
    const city = {
      ...radius,
      delivery_scope: 'CITY_WIDE',
      radius_km: null,
      serviceable_palikas: ['Lalitpur Metropolitan City', 'Kirtipur Municipality'],
    };
    const fleet = {
      fulfillment_mode: 'PLATFORM_FLEET',
      delivery_scope: 'NATION_WIDE',
      radius_km: null,
      serviceable_palikas: [],
      base_delivery_fee_npr: 0,
      delivery_fee_per_km_npr: 0,
      free_delivery_above_npr: null,
    };

    const put = (token: string, body: unknown) =>
      request(t.app)
        .put('/api/vendor/delivery-settings')
        .set('authorization', token)
        .send(body as object);

    it('saves the radius tier with the shop’s own charges, and audits before and after', async () => {
      const { vendorId, userId, token } = await shop({ baseDeliveryFee: 50, radiusKm: 5 });

      const res = await put(token, radius);

      expect(res.status).toBe(200);
      expect(bodyOf(deliverySettingsResponseSchema, res)).toMatchObject({
        radius_km: 7.5,
        base_delivery_fee_npr: 40,
        delivery_fee_per_km_npr: 10,
        free_delivery_above_npr: 1500,
        serviceable_palikas: ['Kathmandu Metropolitan City'],
      });
      expect(await vendorRow(vendorId)).toMatchObject({
        radius_km: 7.5,
        base_delivery_fee_npr: 40,
        delivery_fee_per_km_npr: 10,
        free_delivery_above_npr: 1500,
      });
      const entries = await auditEntries(vendorId);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        action: 'DELIVERY_SETTINGS_CHANGED',
        actor_user_id: userId,
        actor_role: 'VENDOR',
        before_state: { radius_km: 5, base_delivery_fee_npr: 50, delivery_fee_per_km_npr: 0 },
        after_state: { radius_km: 7.5, base_delivery_fee_npr: 40, delivery_fee_per_km_npr: 10 },
      });
    });

    it('saves the city tier with the shop’s own Palika first, and keeps the stored radius', async () => {
      const { vendorId, token } = await shop({ radiusKm: 5 });

      const res = await put(token, city);

      expect(bodyOf(deliverySettingsResponseSchema, res)).toMatchObject({
        delivery_scope: 'CITY_WIDE',
        radius_km: 5,
        serviceable_palikas: [
          'Kathmandu Metropolitan City',
          'Lalitpur Metropolitan City',
          'Kirtipur Municipality',
        ],
      });
      // Listing its own Palika, in any letter case, does not duplicate it.
      await put(token, {
        ...city,
        serviceable_palikas: ['kathmandu metropolitan city', 'Bhaktapur Municipality'],
      });
      expect((await vendorRow(vendorId)).serviceable_palikas).toEqual([
        'Kathmandu Metropolitan City',
        'Bhaktapur Municipality',
      ]);
    });

    it('serves only its own Palika by the list once it leaves the city tier', async () => {
      const { vendorId, token } = await shop();
      await put(token, city);

      const res = await put(token, { ...radius, delivery_scope: 'NATION_WIDE', radius_km: null });

      expect(res.status).toBe(200);
      expect(await vendorRow(vendorId)).toMatchObject({
        delivery_scope: 'NATION_WIDE',
        serviceable_palikas: ['Kathmandu Metropolitan City'],
      });
    });

    it('switches to platform delivery, where the shop sets no charge', async () => {
      const { vendorId, token } = await shop({ baseDeliveryFee: 50 });

      const res = await put(token, fleet);

      expect(res.status).toBe(200);
      expect(bodyOf(deliverySettingsResponseSchema, res)).toMatchObject({
        fulfillment_mode: 'PLATFORM_FLEET',
        base_delivery_fee_npr: 0,
        fulfillment_mode_enabled: true,
      });
      expect((await vendorRow(vendorId)).fulfillment_mode).toBe('PLATFORM_FLEET');
      for (const body of [
        { ...fleet, base_delivery_fee_npr: 50 },
        { ...fleet, free_delivery_above_npr: 1000 },
      ]) {
        expect((await put(token, body)).status).toBe(400);
      }
    });

    it('refuses a mode the Super Admin has switched off, and changes nothing', async () => {
      const { vendorId, token } = await shop();
      await db.update(platformSettings).set({ platform_fleet_enabled: false });

      const res = await put(token, fleet);

      expect(res.status).toBe(422);
      expect(errorOf(res)).toMatchObject({
        code: 'DELIVERY_MODE_DISABLED',
        details: { fulfillment_mode: 'PLATFORM_FLEET' },
      });
      expect((await vendorRow(vendorId)).fulfillment_mode).toBe('SELF_DELIVERY');
      expect(await auditEntries(vendorId)).toEqual([]);
    });

    it('lets a shop on a switched-off mode save its other settings, or move to an enabled one', async () => {
      const { vendorId, token } = await shop();
      await db.update(platformSettings).set({ self_delivery_enabled: false });

      // Not choosing the disabled mode: it already has it.
      const kept = await put(token, radius);
      expect(kept.status).toBe(200);
      expect(bodyOf(deliverySettingsResponseSchema, kept).fulfillment_mode_enabled).toBe(false);

      const moved = await put(token, fleet);
      expect(moved.status).toBe(200);
      expect(bodyOf(deliverySettingsResponseSchema, moved).fulfillment_mode_enabled).toBe(true);
      expect((await vendorRow(vendorId)).fulfillment_mode).toBe('PLATFORM_FLEET');
    });

    it('cannot choose any mode during the Emergency Stop', async () => {
      const { token } = await shop();
      await db
        .update(platformSettings)
        .set({ self_delivery_enabled: false, platform_fleet_enabled: false });

      expect((await put(token, fleet)).status).toBe(422);
      const kept = await put(token, radius);
      expect(kept.status).toBe(200);
      expect(bodyOf(deliverySettingsResponseSchema, kept).fulfillment_mode_enabled).toBe(false);
    });

    it('changes and records nothing when the same settings are saved again', async () => {
      const { vendorId, token } = await shop();
      await put(token, radius);
      const updatedAt = (await vendorRow(vendorId)).updated_at;

      const res = await put(token, radius);

      expect(res.status).toBe(200);
      expect((await vendorRow(vendorId)).updated_at).toEqual(updatedAt);
      expect(await auditEntries(vendorId)).toHaveLength(1);
    });

    it('refuses invalid settings with 400 and stores nothing', async () => {
      const { vendorId, token } = await shop({ radiusKm: 5 });
      const others = PALIKAS.filter((name) => name !== 'Kathmandu Metropolitan City');
      for (const body of [
        { ...radius, radius_km: null },
        { ...radius, radius_km: 0 },
        { ...radius, radius_km: 100.01 },
        { ...radius, serviceable_palikas: ['Lalitpur Metropolitan City'] },
        { ...radius, fulfillment_mode: 'EMERGENCY_FLEET' },
        { ...radius, fulfillment_mode: 'NONE' },
        { ...radius, base_delivery_fee_npr: -1 },
        { ...radius, free_delivery_above_npr: 0 },
        { ...radius, accepting_orders: false },
        { ...city, serviceable_palikas: ['Bhaktapur', 'bhaktapur'] },
        // Not a known Palika (Phase 25: names come from the canonical list).
        { ...city, serviceable_palikas: ['Gotham City'] },
        {},
      ]) {
        const res = await put(token, body);
        expect(res.status).toBe(400);
        expect(errorOf(res).code).toBe('VALIDATION_FAILED');
      }
      expect(await vendorRow(vendorId)).toMatchObject({
        radius_km: 5,
        delivery_scope: 'RADIUS_BOUND',
      });
      expect(await auditEntries(vendorId)).toEqual([]);
      // Every other known Palika, in any letter case, is accepted.
      const all = await put(token, {
        ...city,
        serviceable_palikas: others.map((name) => name.toUpperCase()),
      });
      expect(all.status).toBe(200);
      // Stored in the list's own spelling.
      expect((await vendorRow(vendorId)).serviceable_palikas).toEqual([
        'Kathmandu Metropolitan City',
        ...others,
      ]);
    });

    it('only ever touches the caller’s own shop, and needs a vendor with one', async () => {
      const mine = await shop({ radiusKm: 5 });
      const other = await shop({ radiusKm: 5 });
      await put(mine.token, radius);
      expect((await vendorRow(other.vendorId)).radius_km).toBe(5);

      expect((await request(t.app).get('/api/vendor/delivery-settings')).status).toBe(401);
      for (const role of ['CUSTOMER', 'DRIVER', 'SUPER_ADMIN'] as UserRole[]) {
        expect((await put(bearer(await createUser(db, role), role), radius)).status).toBe(403);
      }
      const shopless = bearer(await createUser(db, 'VENDOR'), 'VENDOR');
      expect((await put(shopless, radius)).status).toBe(404);
      expect(
        (await request(t.app).get('/api/vendor/delivery-settings').set('authorization', shopless))
          .status,
      ).toBe(404);
    });

    it('leaves the existing vendor routes under /api/vendor as they were', async () => {
      const { token } = await shop();
      expect(
        (await request(t.app).get('/api/vendor/products').set('authorization', token)).status,
      ).toBe(200);
      expect(
        (await request(t.app).get('/api/vendor/finance/ledger').set('authorization', token)).status,
      ).toBe(200);
      const unknown = await request(t.app)
        .get('/api/vendor/nothing-here')
        .set('authorization', token);
      expect(unknown.status).toBe(404);
      expect(errorOf(unknown).code).toBe('NOT_FOUND');
    });
  });
});
