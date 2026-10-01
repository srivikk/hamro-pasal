import { randomUUID } from 'node:crypto';

import { outboxEvents, vendors, type Database } from '@hamro-pasal/db';
import {
  adminVendorListResponseSchema,
  adminVendorOverrideResponseSchema,
  vendorStatusOverriddenPayloadSchema,
  walletTopUpResponseSchema,
  type AdminVendorView,
  type VendorStatus,
} from '@hamro-pasal/shared-types';
import { and, eq } from 'drizzle-orm';
import request from 'supertest';

import { WalletService } from '../src/wallet/wallet-service';
import { bearer, bodyOf, buildTestApp, errorOf, type TestApp } from './support/http';
import {
  createOrder,
  createUser,
  createVendor,
  markDelivered,
  vendorUserIdOf,
} from './support/fixtures';

/**
 * Phase 15: the Super Admin's vendor list and the manual Suspend / Restore overrides, applied by
 * WalletService on real PostgreSQL (wallet trigger, CHECK constraints, outbox).
 */
describe('Admin vendor management API', () => {
  let testApp: TestApp;
  let db: Database;
  let adminId: string;
  let admin: string;
  let auditLines: string[];
  let warnSpy: jest.SpyInstance;

  beforeAll(async () => {
    testApp = buildTestApp();
    db = testApp.container.db;
    adminId = await createUser(db, 'SUPER_ADMIN');
    admin = bearer(adminId, 'SUPER_ADMIN');
  });

  beforeEach(() => {
    auditLines = [];
    warnSpy = jest.spyOn(console, 'warn').mockImplementation((line: unknown) => {
      auditLines.push(String(line));
    });
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  afterAll(async () => {
    await testApp.container.close();
  });

  async function vendorRow(vendorId: string) {
    const [row] = await db.select().from(vendors).where(eq(vendors.id, vendorId));
    if (row === undefined) throw new Error('vendor not found');
    return row;
  }

  async function overrideEvents(vendorId: string) {
    const rows = await db
      .select()
      .from(outboxEvents)
      .where(
        and(
          eq(outboxEvents.aggregate_id, vendorId),
          eq(outboxEvents.event_type, 'vendor.status_overridden'),
        ),
      );
    for (const row of rows) expect(row.topic).toBe('notifications.broadcast');
    return rows.map((row) => vendorStatusOverriddenPayloadSchema.parse(row.payload));
  }

  /** A COD self-delivery order settled: the vendor's wallet is debited the commission. */
  async function codCommission(vendorId: string, commissionNpr: number) {
    const order = await createOrder(db, {
      vendorId,
      customerId: await createUser(db),
      subtotal: commissionNpr * 10,
      commission: commissionNpr,
    });
    await markDelivered(db, order.id);
    await testApp.container.settlement.settleOrder(order.id);
  }

  async function topUp(vendorId: string, amountNpr: number) {
    const res = await request(testApp.app)
      .post('/api/vendors/wallet/top-up')
      .set('Authorization', bearer(await vendorUserIdOf(db, vendorId), 'VENDOR'))
      .send({ idempotency_key: `admin-test-${randomUUID()}`, amount_npr: amountNpr });
    expect(res.status).toBe(201);
    return bodyOf(walletTopUpResponseSchema, res);
  }

  function suspend(vendorId: string, token = admin) {
    return request(testApp.app)
      .post(`/api/admin/vendors/${vendorId}/suspend`)
      .set('Authorization', token);
  }

  function restore(vendorId: string, token = admin) {
    return request(testApp.app)
      .post(`/api/admin/vendors/${vendorId}/restore`)
      .set('Authorization', token);
  }

  async function listed(vendorId: string): Promise<AdminVendorView> {
    const res = await request(testApp.app).get('/api/admin/vendors').set('Authorization', admin);
    expect(res.status).toBe(200);
    const vendor = bodyOf(adminVendorListResponseSchema, res).vendors.find(
      (v) => v.id === vendorId,
    );
    if (vendor === undefined) throw new Error(`vendor ${vendorId} not listed`);
    return vendor;
  }

  describe('GET /api/admin/vendors', () => {
    it('lists every vendor with its wallet balance, standing and the limit', async () => {
      const healthy = await createVendor(db, { businessName: `AAA Admin ${randomUUID()}` });
      const approved = await createVendor(db, {
        businessName: `AAB Admin ${randomUUID()}`,
        status: 'APPROVED',
      });
      await codCommission(healthy, 100);

      const res = await request(testApp.app).get('/api/admin/vendors').set('Authorization', admin);

      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
      const body = bodyOf(adminVendorListResponseSchema, res);
      expect(body.suspension_limit_npr).toBe(-2000);
      const mine = body.vendors.filter((v) => v.id === healthy || v.id === approved);
      expect(mine).toEqual([
        expect.objectContaining({
          id: healthy,
          status: 'LIVE',
          suspension: 'NONE',
          restore_status: null,
          wallet_balance_npr: -100,
          phone: '+9779800000000',
          pricing_model: 'COMMISSION',
          fulfillment_mode: 'SELF_DELIVERY',
        }),
        expect.objectContaining({ id: approved, status: 'APPROVED', suspension: 'NONE' }),
      ]);
      // Sorted by business name.
      const names = body.vendors.map((v) => v.business_name);
      expect(names).toEqual([...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
    });

    it('tells debt, admin and unexplained suspensions apart', async () => {
      const debt = await createVendor(db);
      await codCommission(debt, 2500);
      const byAdmin = await createVendor(db, { status: 'APPROVED' });
      expect((await suspend(byAdmin)).status).toBe(200);
      const unexplained = await createVendor(db, { status: 'SUSPENDED' });

      expect(await listed(debt)).toMatchObject({
        status: 'SUSPENDED',
        suspension: 'DEBT',
        restore_status: 'LIVE',
        wallet_balance_npr: -2500,
      });
      expect(await listed(byAdmin)).toMatchObject({
        status: 'SUSPENDED',
        suspension: 'ADMIN',
        restore_status: 'APPROVED',
      });
      expect(await listed(unexplained)).toMatchObject({
        status: 'SUSPENDED',
        suspension: 'UNSPECIFIED',
        restore_status: null,
      });
    });
  });

  describe('POST /api/admin/vendors/:id/suspend', () => {
    it('suspends a LIVE vendor, remembers LIVE, writes the audit event and log line', async () => {
      const vendorId = await createVendor(db);

      const res = await suspend(vendorId);

      expect(res.status).toBe(200);
      const body = bodyOf(adminVendorOverrideResponseSchema, res);
      expect(body.previous_status).toBe('LIVE');
      expect(body.vendor).toMatchObject({
        id: vendorId,
        status: 'SUSPENDED',
        suspension: 'ADMIN',
        restore_status: 'LIVE',
      });
      const row = await vendorRow(vendorId);
      expect(row.status).toBe('SUSPENDED');
      expect(row.status_before_admin_suspension).toBe('LIVE');
      expect(row.status_before_debt_suspension).toBeNull();
      expect(await overrideEvents(vendorId)).toEqual([
        expect.objectContaining({
          vendor_id: vendorId,
          action: 'SUSPEND',
          from_status: 'LIVE',
          to_status: 'SUSPENDED',
          wallet_balance_npr: 0,
          admin_user_id: adminId,
        }),
      ]);
      const audit = auditLines.map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(audit).toEqual([
        expect.objectContaining({
          audit: 'vendor.status_overridden',
          vendor_id: vendorId,
          action: 'SUSPEND',
          admin_user_id: adminId,
        }),
      ]);
    });

    it('refuses a vendor that is already suspended, for debt or by an admin', async () => {
      const byAdmin = await createVendor(db);
      expect((await suspend(byAdmin)).status).toBe(200);
      const debt = await createVendor(db);
      await codCommission(debt, 2500);

      for (const vendorId of [byAdmin, debt]) {
        const res = await suspend(vendorId);
        expect(res.status).toBe(409);
        expect(errorOf(res)).toMatchObject({
          code: 'VENDOR_STATUS_CONFLICT',
          details: { status: 'SUSPENDED' },
        });
      }
      // The debt suspension keeps its own restore status (paying still lifts it).
      expect((await vendorRow(debt)).status_before_debt_suspension).toBe('LIVE');
      expect(await overrideEvents(debt)).toEqual([]);
    });

    it('lets exactly one of several simultaneous suspensions win', async () => {
      const vendorId = await createVendor(db);

      const results = await Promise.all([1, 2, 3, 4, 5].map(() => suspend(vendorId)));

      expect(results.map((res) => res.status).sort()).toEqual([200, 409, 409, 409, 409]);
      expect(await overrideEvents(vendorId)).toHaveLength(1);
    });

    it('waits for an override holding the vendor row, then sees its result', async () => {
      const vendorId = await createVendor(db);
      let release = (): void => undefined;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let lockTaken = (): void => undefined;
      const locked = new Promise<void>((resolve) => {
        lockTaken = resolve;
      });
      // Another admin's suspension, still uncommitted, holding the vendor row lock.
      const first = db.transaction(async (tx) => {
        await new WalletService().suspendByAdmin(tx, vendorId, adminId);
        lockTaken();
        await held;
      });
      await locked;

      const second = suspend(vendorId).then((res) => res);
      await new Promise((resolve) => setTimeout(resolve, 200));
      release();
      await first;
      const res = await second;

      // Without the lock it would read LIVE and suspend a second time.
      expect(res.status).toBe(409);
      expect(errorOf(res).code).toBe('VENDOR_STATUS_CONFLICT');
      expect(await overrideEvents(vendorId)).toHaveLength(1);
    });

    it('is not lifted by paying: a top-up leaves an admin suspension in place', async () => {
      const vendorId = await createVendor(db);
      await codCommission(vendorId, 500);
      expect((await suspend(vendorId)).status).toBe(200);

      const paid = await topUp(vendorId, 500);

      expect(paid).toMatchObject({ wallet_balance_npr: 0, status: 'SUSPENDED', restored: false });
      expect(await listed(vendorId)).toMatchObject({ suspension: 'ADMIN', restore_status: 'LIVE' });
    });
  });

  describe('POST /api/admin/vendors/:id/restore', () => {
    it.each<VendorStatus>(['LIVE', 'APPROVED', 'SANDBOXED'])(
      'returns an admin-suspended %s vendor to %s',
      async (status) => {
        const vendorId = await createVendor(db, { status });
        expect((await suspend(vendorId)).status).toBe(200);

        const res = await restore(vendorId);

        expect(res.status).toBe(200);
        const body = bodyOf(adminVendorOverrideResponseSchema, res);
        expect(body.previous_status).toBe('SUSPENDED');
        expect(body.vendor).toMatchObject({ status, suspension: 'NONE', restore_status: null });
        const row = await vendorRow(vendorId);
        expect(row.status_before_admin_suspension).toBeNull();
        expect((await overrideEvents(vendorId)).map((e) => [e.action, e.to_status])).toEqual([
          ['SUSPEND', 'SUSPENDED'],
          ['RESTORE', status],
        ]);
      },
    );

    it('refuses a debt-suspended vendor while the wallet is below the limit', async () => {
      const vendorId = await createVendor(db);
      await codCommission(vendorId, 2500);

      const res = await restore(vendorId);

      expect(res.status).toBe(409);
      expect(errorOf(res)).toMatchObject({
        code: 'WALLET_BELOW_SUSPENSION_LIMIT',
        details: { wallet_balance_npr: -2500, suspension_limit_npr: -2000 },
      });
      expect((await vendorRow(vendorId)).status).toBe('SUSPENDED');
      expect(await overrideEvents(vendorId)).toEqual([]);
    });

    it('lifts a debt suspension early once the wallet is back within the limit', async () => {
      const vendorId = await createVendor(db);
      await codCommission(vendorId, 2500);
      // A partial payment: -1500 is within the limit but still negative, so paying alone does not
      // bring the shop back (Phase 12.5); the admin may.
      expect(await topUp(vendorId, 1000)).toMatchObject({ status: 'SUSPENDED', restored: false });

      const res = await restore(vendorId);

      expect(res.status).toBe(200);
      expect(bodyOf(adminVendorOverrideResponseSchema, res).vendor).toMatchObject({
        status: 'LIVE',
        suspension: 'NONE',
        wallet_balance_npr: -1500,
      });
      const row = await vendorRow(vendorId);
      expect(row.status_before_debt_suspension).toBeNull();
      expect(await overrideEvents(vendorId)).toEqual([
        expect.objectContaining({ action: 'RESTORE', wallet_balance_npr: -1500 }),
      ]);

      // SPEC §5 still applies afterwards: the next debit past the limit suspends for debt again.
      await codCommission(vendorId, 600);
      expect(await listed(vendorId)).toMatchObject({
        status: 'SUSPENDED',
        suspension: 'DEBT',
        wallet_balance_npr: -2100,
      });
    });

    it('refuses a vendor that is not suspended', async () => {
      const vendorId = await createVendor(db, { status: 'APPROVED' });

      const res = await restore(vendorId);

      expect(res.status).toBe(409);
      expect(errorOf(res)).toMatchObject({
        code: 'VENDOR_STATUS_CONFLICT',
        details: { status: 'APPROVED' },
      });
    });

    it('refuses a suspension with no remembered status', async () => {
      const vendorId = await createVendor(db, { status: 'SUSPENDED' });

      const res = await restore(vendorId);

      expect(res.status).toBe(409);
      expect(errorOf(res).code).toBe('RESTORE_STATUS_UNKNOWN');
    });
  });

  it('answers 404 for an unknown vendor and 400 for a malformed id', async () => {
    for (const call of [suspend, restore]) {
      const unknown = await call(randomUUID());
      expect(unknown.status).toBe(404);
      expect(errorOf(unknown).code).toBe('VENDOR_NOT_FOUND');
      const malformed = await call('not-a-uuid');
      expect(malformed.status).toBe(400);
      expect(errorOf(malformed).code).toBe('VALIDATION_FAILED');
    }
  });

  it('serves Super Admins only', async () => {
    const vendorId = await createVendor(db);
    const calls = [
      (token?: string) => {
        const req = request(testApp.app).get('/api/admin/vendors');
        return token === undefined ? req : req.set('Authorization', token);
      },
      (token?: string) => {
        const req = request(testApp.app).post(`/api/admin/vendors/${vendorId}/suspend`);
        return token === undefined ? req : req.set('Authorization', token);
      },
      (token?: string) => {
        const req = request(testApp.app).post(`/api/admin/vendors/${vendorId}/restore`);
        return token === undefined ? req : req.set('Authorization', token);
      },
    ];
    const vendorToken = bearer(await vendorUserIdOf(db, vendorId), 'VENDOR');
    for (const call of calls) {
      expect((await call()).status).toBe(401);
      for (const token of [
        bearer(await createUser(db), 'CUSTOMER'),
        vendorToken,
        bearer(await createUser(db, 'DRIVER'), 'DRIVER'),
      ]) {
        const res = await call(token);
        expect(res.status).toBe(403);
        expect(errorOf(res).code).toBe('FORBIDDEN');
      }
    }
    expect((await vendorRow(vendorId)).status).toBe('LIVE');
  });

  it('keeps an admin and a debt restore status from coexisting (CHECK constraint)', async () => {
    const vendorId = await createVendor(db);
    expect((await suspend(vendorId)).status).toBe(200);

    await expect(
      db
        .update(vendors)
        .set({ status_before_debt_suspension: 'LIVE' })
        .where(eq(vendors.id, vendorId)),
    ).rejects.toThrow();
    await expect(
      db.update(vendors).set({ status: 'LIVE' }).where(eq(vendors.id, vendorId)),
    ).rejects.toThrow();
  });
});
