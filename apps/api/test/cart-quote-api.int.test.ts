import { randomUUID } from 'node:crypto';

import { orders, platformSettings, vendors, type Database } from '@hamro-pasal/db';
import { cartQuoteResponseSchema, checkoutResponseSchema } from '@hamro-pasal/shared-types';
import { eq } from 'drizzle-orm';
import request from 'supertest';

import {
  createProduct,
  createUser,
  createVendor,
  DELIVERY_ADDRESS,
  pointAtDistance,
} from './support/fixtures';
import { bearer, bodyOf, buildTestApp, errorOf, type TestApp } from './support/http';

/**
 * Phase 25: POST /api/cart/quote on real PostgreSQL. The quote and checkout run one pricing path,
 * so a quoted total is the total checkout charges (SPEC core 9).
 */
describe('POST /api/cart/quote', () => {
  let t: TestApp;
  let db: Database;
  const SHOP = { x: 85.3123, y: 27.7154 };

  beforeAll(() => {
    t = buildTestApp();
    db = t.container.db;
  });

  afterEach(async () => {
    await db.update(platformSettings).set({
      self_delivery_enabled: true,
      platform_fleet_enabled: true,
      platform_delivery_fee_npr: 50,
    });
  });

  afterAll(async () => {
    await t.container.close();
  });

  async function addressAt(metres: number) {
    const point = await pointAtDistance(db, SHOP, metres);
    return { ...DELIVERY_ADDRESS, exact_lat: point.y, exact_lng: point.x };
  }

  async function cart(
    vendorId: string,
    priceNpr: number,
    quantity: number,
    address: unknown = DELIVERY_ADDRESS,
  ) {
    const productId = await createProduct(db, vendorId, 50, priceNpr);
    return {
      vendor_id: vendorId,
      items: [{ product_id: productId, quantity }],
      delivery_address: address as object,
    };
  }

  const quote = (customerId: string, body: unknown) =>
    request(t.app)
      .post('/api/cart/quote')
      .set('authorization', bearer(customerId))
      .send(body as object);

  it('prices a cart: subtotal, the shop’s base fee, the total and every payment method', async () => {
    const customerId = await createUser(db);
    const vendorId = await createVendor(db, { baseDeliveryFee: 50 });

    const res = await quote(customerId, await cart(vendorId, 300, 2));

    expect(res.status).toBe(200);
    const body = bodyOf(cartQuoteResponseSchema, res);
    expect(body).toMatchObject({
      subtotal_npr: 600,
      vendor_offer: null,
      platform_promo: null,
      delivery_fee_npr: 50,
      total_npr: 650,
      payment_options: [
        { method: 'ESEWA', available: true },
        { method: 'KHALTI', available: true },
        { method: 'COD', available: true },
        // 2026-10-21: the customer's wallet, empty for a customer who never recharged.
        { method: 'WALLET', available: false, reason: 'INSUFFICIENT_WALLET_BALANCE' },
      ],
    });
    expect(body.distance_km).toBeGreaterThan(0.1);
    expect(body.distance_km).toBeLessThan(0.3);
    // A quote reserves and creates nothing.
    expect(await db.select().from(orders).where(eq(orders.customer_id, customerId))).toEqual([]);
  });

  it('adds the per-km fee for each started kilometre and waives delivery at the threshold', async () => {
    const customerId = await createUser(db);
    const vendorId = await createVendor(db, { baseDeliveryFee: 40, radiusKm: 5 });
    await db
      .update(vendors)
      .set({ delivery_fee_per_km_npr: 10, free_delivery_above_npr: 1500 })
      .where(eq(vendors.id, vendorId));
    const address = await addressAt(2400);

    // 2.4 km is three started kilometres: 40 + 3 x 10.
    const charged = bodyOf(
      cartQuoteResponseSchema,
      await quote(customerId, await cart(vendorId, 700, 2, address)),
    );
    expect(charged).toMatchObject({ subtotal_npr: 1400, delivery_fee_npr: 70, total_npr: 1470 });

    const free = bodyOf(
      cartQuoteResponseSchema,
      await quote(customerId, await cart(vendorId, 750, 2, address)),
    );
    expect(free).toMatchObject({ subtotal_npr: 1500, delivery_fee_npr: 0, total_npr: 1500 });
  });

  it('charges the platform’s fee for a fleet shop, whatever the shop’s own fee says', async () => {
    const customerId = await createUser(db);
    const vendorId = await createVendor(db, {
      fulfillmentMode: 'PLATFORM_FLEET',
      baseDeliveryFee: 999,
    });
    await db.update(platformSettings).set({ platform_delivery_fee_npr: 80 });

    const body = bodyOf(
      cartQuoteResponseSchema,
      await quote(customerId, await cart(vendorId, 500, 1)),
    );

    expect(body).toMatchObject({ delivery_fee_npr: 80, total_npr: 580 });
  });

  it('is what checkout charges: the order carries the quoted fee and total', async () => {
    const customerId = await createUser(db);
    const vendorId = await createVendor(db, { baseDeliveryFee: 40, radiusKm: 5 });
    await db.update(vendors).set({ delivery_fee_per_km_npr: 15 }).where(eq(vendors.id, vendorId));
    const body = await cart(vendorId, 450, 2, await addressAt(3200));

    const quoted = bodyOf(cartQuoteResponseSchema, await quote(customerId, body));
    const placed = await request(t.app)
      .post('/api/cart/checkout')
      .set('authorization', bearer(customerId))
      // A client that sends its own amounts is ignored: the schema has no such key.
      .send({ ...body, idempotency_key: randomUUID(), payment_method: 'COD' });

    expect(quoted).toMatchObject({ subtotal_npr: 900, delivery_fee_npr: 100, total_npr: 1000 });
    expect(placed.status).toBe(201);
    expect(bodyOf(checkoutResponseSchema, placed).order).toMatchObject({
      subtotal_npr: quoted.subtotal_npr,
      delivery_fee_npr: quoted.delivery_fee_npr,
      total_npr: quoted.total_npr,
    });
  });

  it('offers only the methods the shop accepts, and checkout refuses the others', async () => {
    const customerId = await createUser(db);
    const vendorId = await createVendor(db);
    await db
      .update(vendors)
      .set({ accepted_payment_methods: ['COD'] })
      .where(eq(vendors.id, vendorId));
    const body = await cart(vendorId, 300, 1);

    const quoted = bodyOf(cartQuoteResponseSchema, await quote(customerId, body));
    expect(quoted.payment_options).toEqual([
      { method: 'ESEWA', available: false, reason: 'NOT_ACCEPTED_BY_SHOP' },
      { method: 'KHALTI', available: false, reason: 'NOT_ACCEPTED_BY_SHOP' },
      { method: 'COD', available: true },
      // The wallet follows eSewa / Khalti: a cash-only shop does not take it either.
      { method: 'WALLET', available: false, reason: 'NOT_ACCEPTED_BY_SHOP' },
    ]);

    const refused = await request(t.app)
      .post('/api/cart/checkout')
      .set('authorization', bearer(customerId))
      .send({ ...body, idempotency_key: randomUUID(), payment_method: 'ESEWA' });
    expect(refused.status).toBe(422);
    expect(errorOf(refused)).toMatchObject({
      code: 'PAYMENT_METHOD_UNAVAILABLE',
      details: { accepted: ['COD'] },
    });
  });

  it('refuses what checkout would refuse, with the same codes', async () => {
    const customerId = await createUser(db);
    const vendorId = await createVendor(db, { minOrderValue: 500, radiusKm: 5 });

    const belowMinimum = await quote(customerId, await cart(vendorId, 100, 1));
    expect([belowMinimum.status, errorOf(belowMinimum).code]).toEqual([
      422,
      'BELOW_MINIMUM_ORDER_VALUE',
    ]);

    const tooFar = await quote(customerId, await cart(vendorId, 600, 1, await addressAt(5600)));
    expect([tooFar.status, errorOf(tooFar).code]).toEqual([422, 'OUTSIDE_DELIVERY_AREA']);

    const tooMany = await quote(customerId, await cart(vendorId, 600, 51));
    expect([tooMany.status, errorOf(tooMany).code]).toEqual([409, 'INSUFFICIENT_STOCK']);
  });

  it('says delivery is available on an ordinary quote', async () => {
    const customerId = await createUser(db);
    const vendorId = await createVendor(db);

    const body = bodyOf(
      cartQuoteResponseSchema,
      await quote(customerId, await cart(vendorId, 600, 1)),
    );

    expect(body.delivery_available).toBe(true);
    expect(body.payment_options.some((option) => option.available)).toBe(true);
  });

  it('still prices the cart during the Emergency Stop, flagged, with nothing to pay with', async () => {
    const customerId = await createUser(db);
    const vendorId = await createVendor(db, { baseDeliveryFee: 50 });
    const body = await cart(vendorId, 600, 1);
    await db
      .update(platformSettings)
      .set({ self_delivery_enabled: false, platform_fleet_enabled: false });

    const res = await quote(customerId, body);

    expect(res.status).toBe(200);
    expect(bodyOf(cartQuoteResponseSchema, res)).toMatchObject({
      delivery_available: false,
      subtotal_npr: 600,
      delivery_fee_npr: 50,
      total_npr: 650,
      payment_options: [
        { method: 'ESEWA', available: false, reason: 'DELIVERY_UNAVAILABLE' },
        { method: 'KHALTI', available: false, reason: 'DELIVERY_UNAVAILABLE' },
        { method: 'COD', available: false, reason: 'DELIVERY_UNAVAILABLE' },
        { method: 'WALLET', available: false, reason: 'DELIVERY_UNAVAILABLE' },
      ],
    });
    // Checkout is the rule: it refuses the order.
    const placed = await request(t.app)
      .post('/api/cart/checkout')
      .set('authorization', bearer(customerId))
      .send({ ...(body as object), idempotency_key: randomUUID(), payment_method: 'COD' });
    expect([placed.status, errorOf(placed).code]).toEqual([422, 'DELIVERY_UNAVAILABLE']);
  });

  it('flags a shop whose own delivery mode is switched off, and no other shop', async () => {
    const customerId = await createUser(db);
    const self = await createVendor(db);
    const fleet = await createVendor(db, { fulfillmentMode: 'PLATFORM_FLEET' });
    const selfCart = await cart(self, 600, 1);
    const fleetCart = await cart(fleet, 600, 1);
    await db.update(platformSettings).set({ self_delivery_enabled: false });

    const off = bodyOf(cartQuoteResponseSchema, await quote(customerId, selfCart));
    const on = bodyOf(cartQuoteResponseSchema, await quote(customerId, fleetCart));

    expect(off.delivery_available).toBe(false);
    expect(off.payment_options.every((option) => !option.available)).toBe(true);
    expect(on.delivery_available).toBe(true);
    expect(on.payment_options.some((option) => option.available)).toBe(true);
    // The other refusals are unchanged while delivery is off: the address is still checked.
    const tooFar = await quote(customerId, await cart(self, 600, 1, await addressAt(5600)));
    expect([tooFar.status, errorOf(tooFar).code]).toEqual([422, 'OUTSIDE_DELIVERY_AREA']);

    // Back the moment the mode is switched on: derived, nothing stored.
    await db.update(platformSettings).set({ self_delivery_enabled: true });
    expect(
      bodyOf(cartQuoteResponseSchema, await quote(customerId, selfCart)).delivery_available,
    ).toBe(true);
  });

  it('takes no amounts from the client, and needs a customer', async () => {
    const customerId = await createUser(db);
    const vendorId = await createVendor(db);
    const body = await cart(vendorId, 300, 1);

    for (const extra of [{ total_npr: 1 }, { delivery_fee_npr: 0 }, { payment_method: 'COD' }]) {
      const res = await quote(customerId, { ...body, ...extra });
      expect(res.status).toBe(400);
      expect(errorOf(res).code).toBe('VALIDATION_FAILED');
    }
    expect((await request(t.app).post('/api/cart/quote').send(body)).status).toBe(401);
    const vendorUser = await createUser(db, 'VENDOR');
    expect(
      (
        await request(t.app)
          .post('/api/cart/quote')
          .set('authorization', bearer(vendorUser, 'VENDOR'))
          .send(body)
      ).status,
    ).toBe(403);
  });
});
