import { randomUUID } from 'node:crypto';

import {
  auditLogs,
  platformSettings,
  pricingPlans,
  vendorSettingChanges,
  vendors,
  type Database,
} from '@hamro-pasal/db';
import {
  billingChangeResponseSchema,
  feedResponseSchema,
  vendorMenuSchema,
} from '@hamro-pasal/shared-types';
import { eq, sql } from 'drizzle-orm';
import request from 'supertest';

import {
  createProduct,
  createUser,
  createVendor,
  DELIVERY_ADDRESS,
  pointAtDistance,
  vendorUserIdOf,
} from './support/fixtures';
import { bearer, bodyOf, buildTestApp, errorOf, type TestApp } from './support/http';

/**
 * Phase 25 on real PostgreSQL: the Billing Cycle queue (POST / DELETE /api/vendor/billing/changes),
 * and the delivery rules the feed and checkout share (scope tiers, the Super Admin's mode
 * switches, the Emergency Stop).
 */
describe('Billing queue and delivery rules', () => {
  let t: TestApp;
  let db: Database;
  let adminId: string;
  const CYCLE_END = new Date('2099-01-01T00:00:00.000Z');

  beforeAll(async () => {
    t = buildTestApp();
    db = t.container.db;
    adminId = await createUser(db, 'SUPER_ADMIN');
  });

  afterEach(async () => {
    await db
      .update(platformSettings)
      .set({ self_delivery_enabled: true, platform_fleet_enabled: true });
  });

  afterAll(async () => {
    await t.container.close();
  });

  async function shop(options: Parameters<typeof createVendor>[1] = {}, cycle = true) {
    const vendorId = await createVendor(db, options);
    if (cycle) {
      await db
        .update(vendors)
        .set({
          billing_cycle_started_at: new Date('2020-01-01T00:00:00Z'),
          billing_cycle_ends_at: CYCLE_END,
        })
        .where(eq(vendors.id, vendorId));
    }
    const userId = await vendorUserIdOf(db, vendorId);
    return { vendorId, userId, token: bearer(userId, 'VENDOR') };
  }

  async function plan(values: Partial<typeof pricingPlans.$inferInsert> = {}) {
    const [row] = await db
      .insert(pricingPlans)
      .values({
        name: `Plan ${randomUUID()}`,
        model: 'COMMISSION',
        commission_rate: 8,
        created_by_user_id: adminId,
        ...values,
      })
      .returning();
    if (row === undefined) throw new Error('plan not created');
    return row.id;
  }

  const vendorRow = async (vendorId: string) => {
    const [row] = await db.select().from(vendors).where(eq(vendors.id, vendorId));
    if (row === undefined) throw new Error('vendor not found');
    return row;
  };
  const changesOf = (vendorId: string) =>
    db
      .select()
      .from(vendorSettingChanges)
      .where(eq(vendorSettingChanges.vendor_id, vendorId))
      .orderBy(vendorSettingChanges.requested_at);
  const queue = (token: string, body: unknown) =>
    request(t.app)
      .post('/api/vendor/billing/changes')
      .set('authorization', token)
      .send(body as object);

  describe('POST /api/vendor/billing/changes', () => {
    it('queues a pricing plan for the end of the cycle and changes nothing now', async () => {
      const { vendorId, userId, token } = await shop();
      // Decided 2026-10-21: a shop chooses Subscription plans only.
      const planId = await plan({
        model: 'SUBSCRIPTION',
        commission_rate: 0,
        monthly_fee_npr: 1500,
      });

      const res = await queue(token, {
        setting: 'PRICING_PLAN',
        value: { pricing_plan_id: planId },
      });

      expect(res.status).toBe(202);
      const { change } = bodyOf(billingChangeResponseSchema, res);
      expect(change).toMatchObject({
        setting: 'PRICING_PLAN',
        status: 'PENDING',
        current_value: { pricing_plan_id: null },
        requested_value: { pricing_plan_id: planId },
        effective_from: CYCLE_END.toISOString(),
      });
      // Billing Cycle Lock: the active plan, model and rate are untouched.
      expect(await vendorRow(vendorId)).toMatchObject({
        pricing_plan_id: null,
        pricing_model: 'COMMISSION',
        commission_rate: 0.1,
      });
      const [entry] = await db
        .select()
        .from(auditLogs)
        .where(eq(auditLogs.entity_id, change?.id ?? ''));
      expect(entry).toMatchObject({
        action: 'VENDOR_SETTING_CHANGE_REQUESTED',
        actor_user_id: userId,
        actor_role: 'VENDOR',
        vendor_id: vendorId,
      });
    });

    it('queues payment methods, sorted, and replaces a waiting change of the same setting', async () => {
      const { vendorId, token } = await shop();

      const first = await queue(token, { setting: 'PAYMENT_METHODS', value: { methods: ['COD'] } });
      const second = await queue(token, {
        setting: 'PAYMENT_METHODS',
        value: { methods: ['KHALTI', 'COD'] },
      });

      expect([first.status, second.status]).toEqual([202, 202]);
      const rows = await changesOf(vendorId);
      expect(rows.map((row) => row.status)).toEqual(['SUPERSEDED', 'PENDING']);
      expect(rows[1]?.requested_value).toEqual({ methods: ['COD', 'KHALTI'] });
      expect((await vendorRow(vendorId)).accepted_payment_methods).toEqual([
        'ESEWA',
        'KHALTI',
        'COD',
      ]);
    });

    it('withdraws the waiting change when the active value is asked for', async () => {
      const { vendorId, token } = await shop();
      await queue(token, { setting: 'PAYMENT_METHODS', value: { methods: ['COD'] } });

      const res = await queue(token, {
        setting: 'PAYMENT_METHODS',
        value: { methods: ['COD', 'ESEWA', 'KHALTI'] },
      });

      expect(res.status).toBe(200);
      expect(bodyOf(billingChangeResponseSchema, res).change).toBeNull();
      expect((await changesOf(vendorId)).map((row) => row.status)).toEqual(['SUPERSEDED']);
    });

    it('keeps one waiting change per setting when 5 requests arrive at once', async () => {
      const { vendorId, token } = await shop();
      const responses = await Promise.all(
        Array.from({ length: 5 }, () =>
          queue(token, { setting: 'PAYMENT_METHODS', value: { methods: ['COD'] } }),
        ),
      );
      expect(responses.map((res) => res.status)).toEqual([202, 202, 202, 202, 202]);
      const rows = await changesOf(vendorId);
      expect(rows.filter((row) => row.status === 'PENDING')).toHaveLength(1);
    });

    it('refuses a plan that is unknown or withdrawn, and a shop without a cycle', async () => {
      const { token } = await shop();
      const withdrawn = await plan({ is_offered: false });
      for (const planId of [withdrawn, randomUUID()]) {
        const res = await queue(token, {
          setting: 'PRICING_PLAN',
          value: { pricing_plan_id: planId },
        });
        expect(res.status).toBe(422);
        expect(errorOf(res).code).toBe('PRICING_PLAN_NOT_OFFERED');
      }
      const noCycle = await shop({}, false);
      const res = await queue(noCycle.token, {
        setting: 'PAYMENT_METHODS',
        value: { methods: ['COD'] },
      });
      expect(res.status).toBe(409);
      expect(errorOf(res).code).toBe('BILLING_CYCLE_NOT_STARTED');
      expect(await changesOf(noCycle.vendorId)).toEqual([]);
    });

    it('leaves Commission and Free plans to the Super Admin (decided 2026-10-21), lock-in or not', async () => {
      const { vendorId, token } = await shop({ pricingModel: 'SUBSCRIPTION' });
      for (const lockIn of [sql`now() + interval '10 days'`, sql`now() - interval '1 day'`]) {
        await db.update(vendors).set({ lock_in_expiry: lockIn }).where(eq(vendors.id, vendorId));
        for (const model of ['COMMISSION', 'FREE'] as const) {
          const planId = await plan(
            model === 'FREE' ? { model, commission_rate: 0, duration_cycles: 3 } : { model },
          );
          const refused = await queue(token, {
            setting: 'PRICING_PLAN',
            value: { pricing_plan_id: planId },
          });
          expect(refused.status).toBe(422);
          expect(errorOf(refused)).toMatchObject({ code: 'PRICING_PLAN_ADMIN_ONLY' });
        }
      }
      expect(await changesOf(vendorId)).toEqual([]);
    });

    it('validates the body and the caller', async () => {
      const { token } = await shop();
      for (const body of [
        { setting: 'PAYMENT_METHODS', value: { methods: [] } },
        { setting: 'PAYMENT_METHODS', value: { methods: ['COD', 'COD'] } },
        { setting: 'PAYMENT_METHODS', value: { methods: ['CARD'] } },
        { setting: 'PRICING_PLAN', value: { pricing_plan_id: 'gold' } },
        { setting: 'PRICING_PLAN', value: { pricing_plan_id: randomUUID(), commission_rate: 1 } },
        { setting: 'DELIVERY_MODE', value: {} },
        {},
      ]) {
        expect((await queue(token, body)).status).toBe(400);
      }
      expect((await request(t.app).post('/api/vendor/billing/changes').send({})).status).toBe(401);
      const customer = bearer(await createUser(db, 'CUSTOMER'), 'CUSTOMER');
      expect(
        (await queue(customer, { setting: 'PAYMENT_METHODS', value: { methods: ['COD'] } })).status,
      ).toBe(403);
    });
  });

  describe('DELETE /api/vendor/billing/changes/:id', () => {
    it('withdraws a waiting change, repeatably, and only the caller’s own', async () => {
      const mine = await shop();
      const other = await shop();
      const res = await queue(mine.token, {
        setting: 'PAYMENT_METHODS',
        value: { methods: ['COD'] },
      });
      const id = bodyOf(billingChangeResponseSchema, res).change?.id ?? '';
      const withdraw = (token: string) =>
        request(t.app).delete(`/api/vendor/billing/changes/${id}`).set('authorization', token);

      const foreign = await withdraw(other.token);
      expect(foreign.status).toBe(404);
      expect(errorOf(foreign).code).toBe('SETTING_CHANGE_NOT_FOUND');
      expect((await withdraw(mine.token)).status).toBe(204);
      expect((await withdraw(mine.token)).status).toBe(204);
      expect((await changesOf(mine.vendorId)).map((row) => row.status)).toEqual(['WITHDRAWN']);
      const actions = (await db.select().from(auditLogs).where(eq(auditLogs.entity_id, id))).map(
        (entry) => entry.action,
      );
      expect(actions.sort()).toEqual([
        'VENDOR_SETTING_CHANGE_REQUESTED',
        'VENDOR_SETTING_CHANGE_WITHDRAWN',
      ]);
    });

    it('refuses a change that was replaced', async () => {
      const { token } = await shop();
      const first = await queue(token, { setting: 'PAYMENT_METHODS', value: { methods: ['COD'] } });
      await queue(token, { setting: 'PAYMENT_METHODS', value: { methods: ['ESEWA'] } });
      const id = bodyOf(billingChangeResponseSchema, first).change?.id ?? '';

      const res = await request(t.app)
        .delete(`/api/vendor/billing/changes/${id}`)
        .set('authorization', token);
      expect(res.status).toBe(409);
      expect(errorOf(res)).toMatchObject({
        code: 'SETTING_CHANGE_CLOSED',
        details: { status: 'SUPERSEDED' },
      });
    });
  });

  describe('feed and checkout delivery rules', () => {
    // Far from every other suite's shops, so the 100-per-section cap never hides ours.
    const BIRATNAGAR = { x: 87.2718, y: 26.4525 };
    const address = (overrides: Partial<Record<keyof typeof DELIVERY_ADDRESS, unknown>> = {}) => ({
      ...DELIVERY_ADDRESS,
      province_id: 1,
      district_string: 'Morang',
      municipality_palika_string: 'Biratnagar Metropolitan City',
      exact_lat: BIRATNAGAR.y,
      exact_lng: BIRATNAGAR.x,
      ...overrides,
    });

    async function feedOf(palika?: string) {
      const res = await request(t.app)
        .get('/api/vendors')
        .query({
          lat: BIRATNAGAR.y,
          lng: BIRATNAGAR.x,
          ...(palika === undefined ? {} : { municipality_palika_string: palika }),
        });
      return bodyOf(feedResponseSchema, res);
    }
    async function menuOf(vendorId: string) {
      const res = await request(t.app)
        .get(`/api/vendors/${vendorId}/products`)
        .query({ lat: BIRATNAGAR.y, lng: BIRATNAGAR.x });
      return bodyOf(vendorMenuSchema, res);
    }
    const ids = (entries: readonly { vendor: { id: string } }[]) =>
      entries.map((entry) => entry.vendor.id);

    async function checkout(vendorId: string, deliveryAddress: unknown) {
      const customerId = await createUser(db, 'CUSTOMER');
      const productId = await createProduct(db, vendorId, 5, 100);
      return request(t.app)
        .post('/api/cart/checkout')
        .set('authorization', bearer(customerId))
        .send({
          idempotency_key: randomUUID(),
          vendor_id: vendorId,
          payment_method: 'COD',
          items: [{ product_id: productId, quantity: 1 }],
          delivery_address: deliveryAddress as object,
        });
    }

    it('serves a CITY_WIDE shop’s listed Palikas, in the feed and at checkout', async () => {
      const vendorId = await createVendor(db, {
        deliveryScope: 'CITY_WIDE',
        palika: 'Itahari Sub-Metropolitan City',
        location: BIRATNAGAR,
      });
      // Its own Palika only: Biratnagar is not served.
      expect(ids((await feedOf('Biratnagar Metropolitan City')).explore_further)).toContain(
        vendorId,
      );
      const refused = await checkout(vendorId, address());
      expect(refused.status).toBe(422);
      expect(errorOf(refused).code).toBe('OUTSIDE_DELIVERY_AREA');

      await db
        .update(vendors)
        .set({
          serviceable_palikas: ['Itahari Sub-Metropolitan City', 'Biratnagar Metropolitan City'],
        })
        .where(eq(vendors.id, vendorId));

      expect(ids((await feedOf('Biratnagar Metropolitan City')).serviceable)).toContain(vendorId);
      expect(ids((await feedOf('Dharan Sub-Metropolitan City')).explore_further)).toContain(
        vendorId,
      );
      // No Palika known (a bare GPS fix): a city shop never matches.
      expect(ids((await feedOf()).explore_further)).toContain(vendorId);
      expect((await checkout(vendorId, address())).status).toBe(201);
    });

    it('holds the radius tier to its 10% buffer at checkout, and the national tier to nothing', async () => {
      const radius = await createVendor(db, { radiusKm: 5, location: BIRATNAGAR });
      const inside = await pointAtDistance(db, BIRATNAGAR, 5400);
      const outside = await pointAtDistance(db, BIRATNAGAR, 5600);

      expect(
        (await checkout(radius, address({ exact_lat: inside.y, exact_lng: inside.x }))).status,
      ).toBe(201);
      const refused = await checkout(
        radius,
        address({ exact_lat: outside.y, exact_lng: outside.x }),
      );
      expect(refused.status).toBe(422);
      expect(errorOf(refused)).toMatchObject({
        code: 'OUTSIDE_DELIVERY_AREA',
        message: 'This shop does not deliver to your selected address',
      });

      // A national shop in Biratnagar delivers to Thamel.
      const national = await createVendor(db, {
        deliveryScope: 'NATION_WIDE',
        location: BIRATNAGAR,
      });
      expect((await checkout(national, DELIVERY_ADDRESS)).status).toBe(201);
    });

    it('forces a shop Offline while its delivery mode is switched off, and back on with it', async () => {
      const self = await createVendor(db, { location: BIRATNAGAR });
      const fleet = await createVendor(db, {
        fulfillmentMode: 'PLATFORM_FLEET',
        location: BIRATNAGAR,
      });
      await db.update(platformSettings).set({ self_delivery_enabled: false });

      const feed = await feedOf();
      expect(ids(feed.explore_further)).toContain(self);
      expect(ids(feed.serviceable)).toContain(fleet);
      // Delivery as a whole is on; this one shop's is not.
      expect(feed.delivery_available).toBe(true);
      expect(feed.explore_further.find((entry) => entry.vendor.id === self)).toMatchObject({
        serviceable: false,
        delivery_available: false,
      });
      expect(feed.serviceable.find((entry) => entry.vendor.id === fleet)).toMatchObject({
        serviceable: true,
        delivery_available: true,
      });
      expect((await menuOf(self)).delivery_available).toBe(false);
      expect((await menuOf(fleet)).delivery_available).toBe(true);
      const refused = await checkout(self, address());
      expect(refused.status).toBe(422);
      expect(errorOf(refused).code).toBe('VENDOR_UNAVAILABLE');
      expect((await checkout(fleet, address())).status).toBe(201);
      // Derived: nothing was written to the shop.
      const [row] = await db.select().from(vendors).where(eq(vendors.id, self));
      expect(row).toMatchObject({ status: 'LIVE', fulfillment_mode: 'SELF_DELIVERY' });

      await db.update(platformSettings).set({ self_delivery_enabled: true });
      const back = await feedOf();
      expect(ids(back.serviceable)).toContain(self);
      expect(back.serviceable.find((entry) => entry.vendor.id === self)?.delivery_available).toBe(
        true,
      );
      expect((await checkout(self, address())).status).toBe(201);
    });

    it('lists no shop and refuses every checkout during the Emergency Stop', async () => {
      const vendorId = await createVendor(db, { location: BIRATNAGAR });
      await db
        .update(platformSettings)
        .set({ self_delivery_enabled: false, platform_fleet_enabled: false });

      expect(await feedOf()).toEqual({
        serviceable: [],
        explore_further: [],
        delivery_available: false,
      });
      const res = await checkout(vendorId, address());
      expect(res.status).toBe(422);
      expect(errorOf(res)).toMatchObject({
        code: 'DELIVERY_UNAVAILABLE',
        message: 'Delivery is unavailable at the moment. Please try again later.',
      });
      // The menu still opens, marked as not delivering.
      const menu = await request(t.app)
        .get(`/api/vendors/${vendorId}/products`)
        .query({ lat: BIRATNAGAR.y, lng: BIRATNAGAR.x });
      expect(menu.status).toBe(200);
      expect(bodyOf(vendorMenuSchema, menu)).toMatchObject({
        serviceable: false,
        delivery_available: false,
      });

      await db
        .update(platformSettings)
        .set({ self_delivery_enabled: true, platform_fleet_enabled: true });
      const recovered = await feedOf();
      expect(recovered.delivery_available).toBe(true);
      expect(ids(recovered.serviceable)).toContain(vendorId);
      expect((await checkout(vendorId, address())).status).toBe(201);
    });

    it('marks a shop that simply does not deliver here as available: the two are different', async () => {
      // 20 km away on a 5 km radius: not serviceable, but its delivery is not switched off.
      const far = await createVendor(db, { location: { x: BIRATNAGAR.x + 0.2, y: BIRATNAGAR.y } });

      const feed = await feedOf();

      expect(feed.explore_further.find((entry) => entry.vendor.id === far)).toMatchObject({
        serviceable: false,
        delivery_available: true,
      });
    });
  });
});
