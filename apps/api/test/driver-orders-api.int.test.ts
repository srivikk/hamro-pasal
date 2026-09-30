import { randomUUID } from 'node:crypto';

import { ledgerTransactions, orders } from '@hamro-pasal/db';
import {
  checkoutResponseSchema,
  DELIVERY_OTP_LOCKOUT_SECONDS,
  driverDeliverResponseSchema,
  driverOrderListResponseSchema,
  esewaInitiateResponseSchema,
  orderDetailResponseSchema,
  orderStateChangedPayloadSchema,
  paymentStatusResponseSchema,
} from '@hamro-pasal/shared-types';
import { eq } from 'drizzle-orm';
import request from 'supertest';

import { deliveryOtpKeys } from '../src/orders/delivery-otp-attempts';
import {
  backdatePlacement,
  balanceOf,
  createProduct,
  createUser,
  createVendor,
  DELIVERY_ADDRESS,
  outboxFor,
  vendorUserIdOf,
} from './support/fixtures';
import { bearer, bodyOf, buildTestApp, esewaCallback, errorOf, type TestApp } from './support/http';

/**
 * Phase 11: the vendor dispatches a packed order and the platform rider hands it over with the
 * customer's 4-digit code (customer journey 10, driver flow step 5), over real Express +
 * PostgreSQL + Redis. A matching code delivers, erases the hash and settles escrow in one commit;
 * wrong codes are counted in Redis and the fifth locks the order.
 */
describe('driver orders API', () => {
  let t: TestApp;

  beforeAll(() => {
    t = buildTestApp();
  });

  afterAll(async () => {
    await t.container.close();
  });

  const db = () => t.container.db;

  /** A platform-fleet shop (Patan-style) and a rider. */
  async function setup(fulfillmentMode: 'PLATFORM_FLEET' | 'SELF_DELIVERY' = 'PLATFORM_FLEET') {
    const customerId = await createUser(db());
    const driverId = await createUser(db(), 'DRIVER');
    const vendorId = await createVendor(db(), {
      fulfillmentMode,
      baseDeliveryFee: 50,
      businessName: 'Patan Organic Store',
    });
    const vendorUserId = await vendorUserIdOf(db(), vendorId);
    const productId = await createProduct(db(), vendorId, 10, 500);
    return { customerId, driverId, vendorId, vendorUserId, productId };
  }

  type Setup = Awaited<ReturnType<typeof setup>>;

  /** Checkout of 2 × 500 NPR + 50 NPR fee; returns the order and the customer's raw code. */
  async function checkout(s: Setup, paymentMethod: 'COD' | 'ESEWA' = 'COD') {
    const res = await request(t.app)
      .post('/api/cart/checkout')
      .set('authorization', bearer(s.customerId))
      .send({
        idempotency_key: randomUUID(),
        vendor_id: s.vendorId,
        payment_method: paymentMethod,
        items: [{ product_id: s.productId, quantity: 2 }],
        delivery_address: DELIVERY_ADDRESS,
      });
    expect(res.status).toBe(201);
    const body = bodyOf(checkoutResponseSchema, res);
    if (body.delivery_otp === null) throw new Error('checkout returned no delivery code');
    return { orderId: body.order.id, otp: body.delivery_otp };
  }

  async function payByEsewa(customerId: string, orderId: string) {
    const initiate = await request(t.app)
      .post('/api/payments/esewa/initiate')
      .set('authorization', bearer(customerId))
      .send({ order_id: orderId });
    const transactionUuid = bodyOf(esewaInitiateResponseSchema, initiate).fields.transaction_uuid;
    const paid = await request(t.app)
      .post('/api/payments/esewa/webhook')
      .send({
        data: esewaCallback({ transaction_uuid: transactionUuid ?? '', total_amount: '1050.0' }),
      });
    expect(bodyOf(paymentStatusResponseSchema, paid).payment?.order_state).toBe('PLACED');
  }

  const accept = (s: Setup, orderId: string) =>
    request(t.app)
      .post(`/api/vendors/orders/${orderId}/accept`)
      .set('authorization', bearer(s.vendorUserId, 'VENDOR'));

  const dispatch = (s: Setup, orderId: string) =>
    request(t.app)
      .post(`/api/vendors/orders/${orderId}/dispatch`)
      .set('authorization', bearer(s.vendorUserId, 'VENDOR'));

  /** A real order walked through the API to OUT_FOR_DELIVERY. */
  async function outForDelivery(s: Setup, paymentMethod: 'COD' | 'ESEWA' = 'COD') {
    const placed = await checkout(s, paymentMethod);
    if (paymentMethod === 'ESEWA') await payByEsewa(s.customerId, placed.orderId);
    expect((await accept(s, placed.orderId)).status).toBe(200);
    await backdatePlacement(db(), placed.orderId, 61); // past the customer's 60 s window
    expect((await dispatch(s, placed.orderId)).status).toBe(200);
    return placed;
  }

  const deliver = (
    userId: string,
    orderId: string,
    otp: unknown,
    role: 'DRIVER' | 'CUSTOMER' | 'VENDOR' = 'DRIVER',
    app = t.app,
  ) =>
    request(app)
      .post(`/api/driver/orders/${orderId}/deliver`)
      .set('authorization', bearer(userId, role))
      .send({ delivery_otp: otp });

  const list = (userId: string, role: 'DRIVER' | 'CUSTOMER' | 'VENDOR' = 'DRIVER') =>
    request(t.app).get('/api/driver/orders').set('authorization', bearer(userId, role));

  /** Any 4-digit code other than the real one. */
  const wrongCode = (otp: string) => (otp === '0000' ? '1111' : '0000');

  async function rowOf(orderId: string) {
    const [row] = await db().select().from(orders).where(eq(orders.id, orderId));
    if (row === undefined) throw new Error(`order ${orderId} not found`);
    return row;
  }

  async function transitions(orderId: string) {
    return (await outboxFor(db(), orderId))
      .filter((row) => row.event_type === 'order.state_changed')
      .sort((a, b) => a.occurred_at.getTime() - b.occurred_at.getTime())
      .map((row) => orderStateChangedPayloadSchema.parse(row.payload));
  }

  async function settlementsOf(orderId: string) {
    return (
      await db().select().from(ledgerTransactions).where(eq(ledgerTransactions.order_id, orderId))
    ).filter((row) => row.kind === 'ORDER_SETTLEMENT');
  }

  const failureCount = (orderId: string) =>
    t.container.redisPool.withConnection((redis) => redis.get(deliveryOtpKeys.failures(orderId)));

  describe('POST /api/driver/orders/:id/deliver with the right code', () => {
    it('delivers, stamps delivered_at, erases the hash, records the rider and announces it', async () => {
      const s = await setup();
      const { orderId, otp } = await outForDelivery(s);

      const res = await deliver(s.driverId, orderId, otp);

      expect(res.status).toBe(200);
      const body = bodyOf(driverDeliverResponseSchema, res);
      const row = await rowOf(orderId);
      expect(body).toEqual({
        order_id: orderId,
        state: 'DELIVERED',
        delivered_at: row.delivered_at?.toISOString(),
      });
      expect(row.state).toBe('DELIVERED');
      expect(row.delivered_at).not.toBeNull();
      expect(Math.abs((row.delivered_at?.getTime() ?? 0) - Date.now())).toBeLessThan(10_000);
      expect(row.delivery_otp).toBeNull();
      expect(row.driver_user_id).toBe(s.driverId);
      expect(row.payment_status).toBe('PAID'); // the rider collected the cash

      const last = (await transitions(orderId)).at(-1);
      expect(last).toMatchObject({
        from_state: 'OUT_FOR_DELIVERY',
        to_state: 'DELIVERED',
        payment_status: 'PAID',
        delivered_at: row.delivered_at?.toISOString(),
      });

      const customerView = await request(t.app)
        .get(`/api/orders/${orderId}`)
        .set('authorization', bearer(s.customerId));
      expect(bodyOf(orderDetailResponseSchema, customerView).order).toMatchObject({
        state: 'DELIVERED',
        payment_status: 'PAID',
      });
    });

    it('settles a COD fleet order in the same commit: the rider owes the subtotal', async () => {
      const s = await setup();
      const { orderId, otp } = await outForDelivery(s);
      const revenueBefore = (await balanceOf(db(), 'PLATFORM_REVENUE')) ?? 0;

      expect((await deliver(s.driverId, orderId, otp)).status).toBe(200);

      expect(await settlementsOf(orderId)).toHaveLength(1);
      // Cash 1050 collected, delivery fee 50 earned: net −1000 on the rider's float.
      expect(await balanceOf(db(), { driverUserId: s.driverId })).toBe(-1000);
      // 10% commission of 1000 to the platform, 900 to the vendor.
      expect(await balanceOf(db(), { vendorId: s.vendorId })).toBe(900);
      expect(((await balanceOf(db(), 'PLATFORM_REVENUE')) ?? 0) - revenueBefore).toBeCloseTo(100);
    });

    it('releases a prepaid order from escrow to vendor, rider and platform', async () => {
      const s = await setup();
      const { orderId, otp } = await outForDelivery(s, 'ESEWA');

      expect((await deliver(s.driverId, orderId, otp)).status).toBe(200);

      expect(await settlementsOf(orderId)).toHaveLength(1);
      expect(await balanceOf(db(), { driverUserId: s.driverId })).toBe(50);
      expect(await balanceOf(db(), { vendorId: s.vendorId })).toBe(900);
    });

    it('answers a retry by the same rider with the same success, once in the ledger', async () => {
      const s = await setup();
      const { orderId, otp } = await outForDelivery(s);

      const first = await deliver(s.driverId, orderId, otp);
      const again = await deliver(s.driverId, orderId, otp);

      expect(again.status).toBe(200);
      expect(again.body).toEqual(first.body);
      expect((await transitions(orderId)).filter((e) => e.to_state === 'DELIVERED')).toHaveLength(
        1,
      );
      expect(await settlementsOf(orderId)).toHaveLength(1);
    });

    it('delivers exactly once when the right code is submitted 5 times at once', async () => {
      const s = await setup();
      const { orderId, otp } = await outForDelivery(s);

      const results = await Promise.all(
        Array.from({ length: 5 }, () => deliver(s.driverId, orderId, otp)),
      );

      expect(results.map((res) => res.status)).toEqual([200, 200, 200, 200, 200]);
      expect((await transitions(orderId)).filter((e) => e.to_state === 'DELIVERED')).toHaveLength(
        1,
      );
      expect(await settlementsOf(orderId)).toHaveLength(1);
      expect(await balanceOf(db(), { driverUserId: s.driverId })).toBe(-1000);
    });

    it('refuses the used code to every other rider (it is erased; the order is theirs no more)', async () => {
      const s = await setup();
      const { orderId, otp } = await outForDelivery(s);
      expect((await deliver(s.driverId, orderId, otp)).status).toBe(200);

      const otherRider = await createUser(db(), 'DRIVER');
      const res = await deliver(otherRider, orderId, otp);

      expect(res.status).toBe(404);
      expect(errorOf(res).code).toBe('ORDER_NOT_FOUND');
    });

    it('clears the wrong-code counter once delivered', async () => {
      const s = await setup();
      const { orderId, otp } = await outForDelivery(s);
      await deliver(s.driverId, orderId, wrongCode(otp));
      expect(await failureCount(orderId)).toBe('1');

      expect((await deliver(s.driverId, orderId, otp)).status).toBe(200);

      expect(await failureCount(orderId)).toBeNull();
    });
  });

  describe('wrong codes and the lockout', () => {
    it('denies a wrong code with 401 INVALID_OTP and changes nothing', async () => {
      const s = await setup();
      const { orderId, otp } = await outForDelivery(s);
      const before = await rowOf(orderId);

      const res = await deliver(s.driverId, orderId, wrongCode(otp));

      expect(res.status).toBe(401);
      expect(errorOf(res)).toMatchObject({
        code: 'INVALID_OTP',
        details: { attempts_remaining: 4 },
      });
      const after = await rowOf(orderId);
      expect(after.state).toBe('OUT_FOR_DELIVERY');
      expect(after.delivery_otp).toBe(before.delivery_otp);
      expect(after.delivered_at).toBeNull();
      expect(after.driver_user_id).toBeNull();
      expect(await settlementsOf(orderId)).toHaveLength(0);
    });

    it('denies every code but the one issued (neighbours, reversed, zero-padded)', async () => {
      const s = await setup();
      const { orderId, otp } = await outForDelivery(s);
      const n = Number(otp);
      const near = [
        String((n + 1) % 10_000).padStart(4, '0'),
        String((n + 9_999) % 10_000).padStart(4, '0'),
        otp.split('').reverse().join(''),
      ].filter((code) => code !== otp);

      for (const code of near) {
        expect((await deliver(s.driverId, orderId, code)).status).toBe(401);
      }
      expect((await rowOf(orderId)).state).toBe('OUT_FOR_DELIVERY');
    });

    it('counts down, locks on the 5th wrong code, and then refuses even the right one', async () => {
      const s = await setup();
      const { orderId, otp } = await outForDelivery(s);
      const wrong = wrongCode(otp);

      const remaining: unknown[] = [];
      for (let i = 0; i < 4; i += 1) {
        const res = await deliver(s.driverId, orderId, wrong);
        expect(res.status).toBe(401);
        remaining.push(errorOf(res).details);
      }
      expect(remaining).toEqual([4, 3, 2, 1].map((left) => ({ attempts_remaining: left })));

      const fifth = await deliver(s.driverId, orderId, wrong);
      expect(fifth.status).toBe(429);
      const locked = errorOf(fifth);
      expect(locked.code).toBe('DELIVERY_OTP_LOCKED');
      const retryAfter = (locked.details as { retry_after_seconds: number }).retry_after_seconds;
      expect(retryAfter).toBeGreaterThan(DELIVERY_OTP_LOCKOUT_SECONDS - 10);
      expect(retryAfter).toBeLessThanOrEqual(DELIVERY_OTP_LOCKOUT_SECONDS);

      const right = await deliver(s.driverId, orderId, otp);
      expect(right.status).toBe(429);
      expect(errorOf(right).code).toBe('DELIVERY_OTP_LOCKED');
      const row = await rowOf(orderId);
      expect(row.state).toBe('OUT_FOR_DELIVERY');
      expect(row.delivery_otp).not.toBeNull();
    });

    it('counts wrong codes per order, whichever rider types them', async () => {
      const s = await setup();
      const { orderId, otp } = await outForDelivery(s);
      const otherRider = await createUser(db(), 'DRIVER');

      await deliver(s.driverId, orderId, wrongCode(otp));
      const res = await deliver(otherRider, orderId, wrongCode(otp));

      expect(errorOf(res).details).toEqual({ attempts_remaining: 3 });
    });

    it('lets no concurrent guess past the limit: 10 at once → four 401s, six 429s', async () => {
      const s = await setup();
      const { orderId, otp } = await outForDelivery(s);

      const results = await Promise.all(
        Array.from({ length: 10 }, () => deliver(s.driverId, orderId, wrongCode(otp))),
      );

      const statuses = results.map((res) => res.status).sort();
      expect(statuses).toEqual([401, 401, 401, 401, 429, 429, 429, 429, 429, 429]);
      expect(await failureCount(orderId)).toBe('5');
    });

    it('keeps the lockout per order: another order of the rider is unaffected', async () => {
      const s = await setup();
      const first = await outForDelivery(s);
      const second = await outForDelivery(s);
      for (let i = 0; i < 5; i += 1) await deliver(s.driverId, first.orderId, wrongCode(first.otp));

      expect((await deliver(s.driverId, second.orderId, second.otp)).status).toBe(200);
    });

    it('accepts the right code again once the lockout has run out', async () => {
      const short = buildTestApp({ deliveryOtpLockoutMs: 400 });
      try {
        const s = await setup();
        const { orderId, otp } = await outForDelivery(s);
        for (let i = 0; i < 5; i += 1) {
          await deliver(s.driverId, orderId, wrongCode(otp), 'DRIVER', short.app);
        }
        expect((await deliver(s.driverId, orderId, otp, 'DRIVER', short.app)).status).toBe(429);

        await new Promise((resolve) => setTimeout(resolve, 600));

        expect((await deliver(s.driverId, orderId, otp, 'DRIVER', short.app)).status).toBe(200);
      } finally {
        await short.container.close();
      }
    });
  });

  describe('which orders a rider may deliver', () => {
    it('refuses an order that is not out for delivery with 409, without counting an attempt', async () => {
      const s = await setup();
      const { orderId, otp } = await checkout(s);
      await accept(s, orderId);

      const res = await deliver(s.driverId, orderId, otp);

      expect(res.status).toBe(409);
      expect(errorOf(res)).toMatchObject({
        code: 'ORDER_STATE_CONFLICT',
        details: { state: 'PREPARING' },
      });
      expect(await failureCount(orderId)).toBeNull();
    });

    it("hides a self-delivery order (the vendor's staff hand it over) and unknown ids", async () => {
      const s = await setup('SELF_DELIVERY');
      const { orderId, otp } = await outForDelivery(s);

      const own = await deliver(s.driverId, orderId, otp);
      const unknown = await deliver(s.driverId, randomUUID(), otp);

      for (const res of [own, unknown]) {
        expect(res.status).toBe(404);
        expect(errorOf(res).code).toBe('ORDER_NOT_FOUND');
      }
      expect((await rowOf(orderId)).state).toBe('OUT_FOR_DELIVERY');
    });

    it('hides an order another rider already carries', async () => {
      const s = await setup();
      const { orderId, otp } = await outForDelivery(s);
      const otherRider = await createUser(db(), 'DRIVER');
      await db().update(orders).set({ driver_user_id: otherRider }).where(eq(orders.id, orderId));

      const res = await deliver(s.driverId, orderId, otp);

      expect(res.status).toBe(404);
      expect((await deliver(otherRider, orderId, otp)).status).toBe(200);
    });

    it('requires a DRIVER token', async () => {
      const s = await setup();
      const { orderId, otp } = await outForDelivery(s);

      const anonymous = await request(t.app)
        .post(`/api/driver/orders/${orderId}/deliver`)
        .send({ delivery_otp: otp });
      const customer = await deliver(s.customerId, orderId, otp, 'CUSTOMER');
      const vendor = await deliver(s.vendorUserId, orderId, otp, 'VENDOR');

      expect(anonymous.status).toBe(401);
      expect(errorOf(anonymous).code).toBe('UNAUTHENTICATED');
      for (const res of [customer, vendor]) {
        expect(res.status).toBe(403);
        expect(errorOf(res).code).toBe('FORBIDDEN');
      }
      expect((await rowOf(orderId)).state).toBe('OUT_FOR_DELIVERY');
    });

    it('validates the id and the code format before looking at the order', async () => {
      const s = await setup();
      const { orderId } = await outForDelivery(s);

      const badId = await deliver(s.driverId, 'not-a-uuid', '1234');
      const results = await Promise.all(
        ['123', '12345', '12a4', 1234, undefined].map((code) => deliver(s.driverId, orderId, code)),
      );

      for (const res of [badId, ...results]) {
        expect(res.status).toBe(400);
        expect(errorOf(res).code).toBe('VALIDATION_FAILED');
      }
      expect(await failureCount(orderId)).toBeNull();
    });
  });

  describe('GET /api/driver/orders', () => {
    it("lists fleet orders out for delivery that are unclaimed or the rider's", async () => {
      const s = await setup();
      const unclaimed = await outForDelivery(s);
      const mine = await outForDelivery(s);
      const someoneElses = await outForDelivery(s);
      const preparing = await checkout(s);
      await accept(s, preparing.orderId);
      const otherRider = await createUser(db(), 'DRIVER');
      await db()
        .update(orders)
        .set({ driver_user_id: s.driverId })
        .where(eq(orders.id, mine.orderId));
      await db()
        .update(orders)
        .set({ driver_user_id: otherRider })
        .where(eq(orders.id, someoneElses.orderId));
      const selfDelivery = await setup('SELF_DELIVERY');
      const selfOrder = await outForDelivery(selfDelivery);

      const res = await list(s.driverId);

      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
      const listed = bodyOf(driverOrderListResponseSchema, res).orders;
      const byId = new Map(listed.map((order) => [order.id, order]));
      expect(byId.get(unclaimed.orderId)?.assigned_to_me).toBe(false);
      expect(byId.get(mine.orderId)?.assigned_to_me).toBe(true);
      expect(byId.has(someoneElses.orderId)).toBe(false);
      expect(byId.has(preparing.orderId)).toBe(false);
      expect(byId.has(selfOrder.orderId)).toBe(false);

      expect(byId.get(unclaimed.orderId)).toMatchObject({
        state: 'OUT_FOR_DELIVERY',
        payment_method: 'COD',
        fulfillment: 'PLATFORM_FLEET',
        total_npr: 1050,
        vendor_business_name: 'Patan Organic Store',
        delivery_address: { ward_number: 26, tole_locality: 'Thamel' },
        items: [{ product_id: s.productId, quantity: 2, unit_price_npr: 500 }],
      });
    });

    it('drops an order from the list once it is delivered', async () => {
      const s = await setup();
      const { orderId, otp } = await outForDelivery(s);
      await deliver(s.driverId, orderId, otp);

      const listed = bodyOf(driverOrderListResponseSchema, await list(s.driverId)).orders;

      expect(listed.map((order) => order.id)).not.toContain(orderId);
    });

    it("never exposes the customer's identity or the code's hash", async () => {
      const s = await setup();
      await outForDelivery(s);

      const raw = JSON.stringify((await list(s.driverId)).body);

      expect(raw).not.toContain('customer_id');
      expect(raw).not.toContain(s.customerId);
      expect(raw).not.toContain('delivery_otp');
      expect(raw).not.toContain('$2');
      expect(raw).not.toContain('+977');
    });

    it('requires a DRIVER token', async () => {
      const s = await setup();

      expect((await list(s.customerId, 'CUSTOMER')).status).toBe(403);
      expect((await list(s.vendorUserId, 'VENDOR')).status).toBe(403);
      expect((await request(t.app).get('/api/driver/orders')).status).toBe(401);
    });
  });
});
