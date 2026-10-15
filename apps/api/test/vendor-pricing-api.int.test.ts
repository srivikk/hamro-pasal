import { auditLogs, vendors, type Database } from '@hamro-pasal/db';
import {
  cartQuoteResponseSchema,
  deliverySettingsResponseSchema,
  feedResponseSchema,
} from '@hamro-pasal/shared-types';
import { and, desc, eq } from 'drizzle-orm';
import request from 'supertest';

import {
  createProduct,
  createUser,
  createVendor,
  DELIVERY_ADDRESS,
  vendorUserIdOf,
} from './support/fixtures';
import { bearer, bodyOf, buildTestApp, errorOf, type TestApp } from './support/http';

/**
 * Step 7.2 (SPEC core 11): the vendor sets its minimum order value from the Seller app; the
 * quote says how much more is needed for free delivery; the feed and menu show the threshold.
 */
describe('Vendor delivery pricing', () => {
  let t: TestApp;
  let db: Database;

  beforeAll(() => {
    t = buildTestApp();
    db = t.container.db;
  });

  afterAll(async () => {
    await t.container.close();
  });

  const settings = {
    fulfillment_mode: 'SELF_DELIVERY',
    delivery_scope: 'RADIUS_BOUND',
    radius_km: 5,
    serviceable_palikas: [],
    base_delivery_fee_npr: 60,
    delivery_fee_per_km_npr: 0,
    free_delivery_above_npr: 1000,
  };

  async function shop(options: Parameters<typeof createVendor>[1] = {}) {
    const vendorId = await createVendor(db, options);
    return { vendorId, token: bearer(await vendorUserIdOf(db, vendorId), 'VENDOR') };
  }

  const put = (token: string, body: object) =>
    request(t.app).put('/api/vendor/delivery-settings').set('authorization', token).send(body);

  const vendorRow = async (id: string) =>
    (await db.select().from(vendors).where(eq(vendors.id, id)))[0];

  describe('PUT /api/vendor/delivery-settings: the minimum order value', () => {
    it('sets it with the flat fee and the threshold, answers it, and audits it', async () => {
      const { vendorId, token } = await shop({ minOrderValue: 0 });

      const res = await put(token, { ...settings, min_order_value: 500 });

      expect(res.status).toBe(200);
      expect(bodyOf(deliverySettingsResponseSchema, res)).toMatchObject({
        min_order_value: 500,
        base_delivery_fee_npr: 60,
        free_delivery_above_npr: 1000,
      });
      expect((await vendorRow(vendorId))?.min_order_value).toBe(500);
      const [entry] = await db
        .select()
        .from(auditLogs)
        .where(
          and(eq(auditLogs.entity_id, vendorId), eq(auditLogs.action, 'DELIVERY_SETTINGS_CHANGED')),
        )
        .orderBy(desc(auditLogs.occurred_at));
      expect(entry?.before_state).toMatchObject({ min_order_value: 0 });
      expect(entry?.after_state).toMatchObject({ min_order_value: 500 });
    });

    it('keeps the stored value when an older app build leaves the field out', async () => {
      const { vendorId, token } = await shop({ minOrderValue: 300 });

      const res = await put(token, settings);

      expect(res.status).toBe(200);
      expect(bodyOf(deliverySettingsResponseSchema, res).min_order_value).toBe(300);
      expect((await vendorRow(vendorId))?.min_order_value).toBe(300);
    });

    it('refuses free delivery at or below the minimum order, sent or stored', async () => {
      const { vendorId, token } = await shop({ minOrderValue: 1200 });

      const sent = await put(token, { ...settings, min_order_value: 1000 });
      expect(sent.status).toBe(400);
      expect(errorOf(sent).code).toBe('VALIDATION_FAILED');

      // The minimum is omitted: the stored 1200 is the one the threshold must clear.
      const stored = await put(token, settings);
      expect(stored.status).toBe(422);
      expect(errorOf(stored)).toMatchObject({
        code: 'FREE_DELIVERY_BELOW_MINIMUM_ORDER',
        details: { min_order_value: 1200 },
      });
      expect((await vendorRow(vendorId))?.free_delivery_above_npr).toBeNull();

      expect((await put(token, { ...settings, free_delivery_above_npr: 1200.01 })).status).toBe(
        200,
      );
    });

    it('refuses a negative value, more than Rs. 50,000, or a fraction of a paisa', async () => {
      const { token } = await shop();
      for (const min of [-1, 50_000.01, 10.005, '500']) {
        const res = await put(token, {
          ...settings,
          free_delivery_above_npr: null,
          min_order_value: min,
        });
        expect(res.status).toBe(400);
      }
      expect(
        (await put(token, { ...settings, free_delivery_above_npr: null, min_order_value: 50_000 }))
          .status,
      ).toBe(200);
    });

    it('lets a platform-delivery shop set it too (the charges stay the platform’s)', async () => {
      const { vendorId, token } = await shop({ fulfillmentMode: 'PLATFORM_FLEET' });

      const res = await put(token, {
        ...settings,
        fulfillment_mode: 'PLATFORM_FLEET',
        base_delivery_fee_npr: 0,
        free_delivery_above_npr: null,
        min_order_value: 400,
      });

      expect(res.status).toBe(200);
      expect((await vendorRow(vendorId))?.min_order_value).toBe(400);
    });
  });

  describe('checkout and the quote', () => {
    async function cartFor(vendorId: string, price: number, quantity: number) {
      return {
        vendor_id: vendorId,
        items: [{ product_id: await createProduct(db, vendorId, 50, price), quantity }],
        delivery_address: DELIVERY_ADDRESS,
      };
    }
    const quote = (customerId: string, body: object) =>
      request(t.app).post('/api/cart/quote').set('authorization', bearer(customerId)).send(body);

    it('enforces the minimum the vendor set at checkout and in the quote', async () => {
      const customerId = await createUser(db);
      const { vendorId, token } = await shop({ minOrderValue: 0 });
      await put(token, { ...settings, free_delivery_above_npr: null, min_order_value: 800 });

      const below = await quote(customerId, await cartFor(vendorId, 250, 3));
      expect(below.status).toBe(422);
      expect(errorOf(below).code).toBe('BELOW_MINIMUM_ORDER_VALUE');
      const checkout = await request(t.app)
        .post('/api/cart/checkout')
        .set('authorization', bearer(customerId))
        .send({
          ...(await cartFor(vendorId, 250, 3)),
          idempotency_key: `mov-${vendorId}`,
          payment_method: 'COD',
        });
      expect(errorOf(checkout).code).toBe('BELOW_MINIMUM_ORDER_VALUE');

      expect((await quote(customerId, await cartFor(vendorId, 400, 2))).status).toBe(200);
    });

    it('says how much more is needed for free delivery, and 0 once it is reached', async () => {
      const customerId = await createUser(db);
      const { vendorId, token } = await shop();
      await put(token, { ...settings, min_order_value: 0 });

      const short = bodyOf(
        cartQuoteResponseSchema,
        await quote(customerId, await cartFor(vendorId, 350.5, 2)),
      );
      expect(short).toMatchObject({
        subtotal_npr: 701,
        delivery_fee_npr: 60,
        free_delivery_threshold_npr: 1000,
        free_delivery_remaining_npr: 299,
      });

      const reached = bodyOf(
        cartQuoteResponseSchema,
        await quote(customerId, await cartFor(vendorId, 500, 2)),
      );
      expect(reached).toMatchObject({
        delivery_fee_npr: 0,
        free_delivery_threshold_npr: 1000,
        free_delivery_remaining_npr: 0,
      });
    });

    it('answers null for a shop without a threshold, and under platform delivery', async () => {
      const customerId = await createUser(db);
      const none = await shop();
      const fleet = await shop({ fulfillmentMode: 'PLATFORM_FLEET' });
      // A stray threshold on a fleet shop (written outside the API) is never offered.
      await db
        .update(vendors)
        .set({ free_delivery_above_npr: 100 })
        .where(eq(vendors.id, fleet.vendorId));

      for (const vendorId of [none.vendorId, fleet.vendorId]) {
        const body = bodyOf(
          cartQuoteResponseSchema,
          await quote(customerId, await cartFor(vendorId, 300, 2)),
        );
        expect(body).toMatchObject({
          free_delivery_threshold_npr: null,
          free_delivery_remaining_npr: null,
        });
      }
    });
  });

  describe('the feed and the menu', () => {
    it('show a self-delivery shop’s threshold, and none for a fleet shop', async () => {
      const own = await shop({ location: { x: 84.0, y: 28.2 } });
      await put(own.token, { ...settings, free_delivery_above_npr: 1500, min_order_value: 0 });
      const fleet = await shop({
        fulfillmentMode: 'PLATFORM_FLEET',
        location: { x: 84.0, y: 28.2 },
      });
      await db
        .update(vendors)
        .set({ free_delivery_above_npr: 100 })
        .where(eq(vendors.id, fleet.vendorId));

      const feed = bodyOf(
        feedResponseSchema,
        await request(t.app).get('/api/vendors').query({ lat: 28.2, lng: 84.0 }),
      );
      const entries = [...feed.serviceable, ...feed.explore_further];
      const thresholdOf = (id: string) =>
        entries.find((entry) => entry.vendor.id === id)?.vendor.free_delivery_above_npr;
      expect(thresholdOf(own.vendorId)).toBe(1500);
      expect(thresholdOf(fleet.vendorId)).toBeNull();

      const menu = await request(t.app)
        .get(`/api/vendors/${own.vendorId}/products`)
        .query({ lat: 28.2, lng: 84.0 });
      expect(menu.status).toBe(200);
      expect((menu.body as { vendor: { free_delivery_above_npr: number } }).vendor).toMatchObject({
        free_delivery_above_npr: 1500,
      });
    });
  });
});
