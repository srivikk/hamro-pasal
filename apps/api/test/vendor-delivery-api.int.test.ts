import { randomUUID } from 'node:crypto';

import { deliveries, ledgerTransactions, orders, vendors } from '@hamro-pasal/db';
import {
  checkoutResponseSchema,
  deliveryConfirmedResponseSchema,
  deliveryListResponseSchema,
  DELIVERY_OTP_LOCKOUT_SECONDS,
  esewaInitiateResponseSchema,
  orderDetailResponseSchema,
  orderStateChangedPayloadSchema,
  paymentStatusResponseSchema,
  vendorOrderListResponseSchema,
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
 * Phase 11.5: the shop's own staff hand over a SELF_DELIVERY order with the customer's code
 * (vendor flow step 9) at POST /api/vendors/orders/:id/deliver. Same handoff as the platform
 * rider (bcrypt check, 5-try Redis lockout, DELIVERED + hash erased + settlement in one commit),
 * but only for SELF_DELIVERY orders. Real Express + PostgreSQL + Redis.
 */
describe('vendor self-delivery handoff API', () => {
  let t: TestApp;

  beforeAll(() => {
    t = buildTestApp();
  });

  afterAll(async () => {
    await t.container.close();
  });

  const db = () => t.container.db;

  async function setup(
    fulfillmentMode: 'SELF_DELIVERY' | 'PLATFORM_FLEET' = 'SELF_DELIVERY',
    priceNpr = 500,
  ) {
    const customerId = await createUser(db());
    const vendorId = await createVendor(db(), { fulfillmentMode, baseDeliveryFee: 50 });
    const vendorUserId = await vendorUserIdOf(db(), vendorId);
    const productId = await createProduct(db(), vendorId, 10, priceNpr);
    return { customerId, vendorId, vendorUserId, productId };
  }

  type Setup = Awaited<ReturnType<typeof setup>>;

  /** Checkout of 2 items + 50 NPR fee; returns the order id and the customer's raw code. */
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

  const vendorPost = (s: Setup, orderId: string, action: string) =>
    request(t.app)
      .post(`/api/vendors/orders/${orderId}/${action}`)
      .set('authorization', bearer(s.vendorUserId, 'VENDOR'));

  /** A real order walked through the API to OUT_FOR_DELIVERY. */
  async function outForDelivery(s: Setup, paymentMethod: 'COD' | 'ESEWA' = 'COD') {
    const placed = await checkout(s, paymentMethod);
    if (paymentMethod === 'ESEWA') await payByEsewa(s.customerId, placed.orderId);
    expect((await vendorPost(s, placed.orderId, 'accept')).status).toBe(200);
    await backdatePlacement(db(), placed.orderId, 61);
    expect((await vendorPost(s, placed.orderId, 'dispatch')).status).toBe(200);
    return placed;
  }

  const deliver = (
    userId: string,
    orderId: string,
    otp: unknown,
    role: 'VENDOR' | 'CUSTOMER' | 'DRIVER' = 'VENDOR',
    app = t.app,
  ) =>
    request(app)
      .post(`/api/vendors/orders/${orderId}/deliver`)
      .set('authorization', bearer(userId, role))
      .send({ delivery_otp: otp });

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

  async function vendorStatus(vendorId: string) {
    const [row] = await db()
      .select({ status: vendors.status })
      .from(vendors)
      .where(eq(vendors.id, vendorId));
    return row?.status;
  }

  describe('a SELF_DELIVERY order with the right code', () => {
    it('delivers, stamps delivered_at, erases the hash and announces it, with no rider', async () => {
      const s = await setup();
      const { orderId, otp } = await outForDelivery(s);

      const res = await deliver(s.vendorUserId, orderId, otp);

      expect(res.status).toBe(200);
      const row = await rowOf(orderId);
      expect(bodyOf(deliveryConfirmedResponseSchema, res)).toEqual({
        order_id: orderId,
        state: 'DELIVERED',
        delivered_at: row.delivered_at?.toISOString(),
      });
      expect(row.state).toBe('DELIVERED');
      expect(Math.abs((row.delivered_at?.getTime() ?? 0) - Date.now())).toBeLessThan(10_000);
      expect(row.delivery_otp).toBeNull();
      expect(row.driver_user_id).toBeNull();
      expect(row.payment_status).toBe('PAID');
      expect((await transitions(orderId)).at(-1)).toMatchObject({
        from_state: 'OUT_FOR_DELIVERY',
        to_state: 'DELIVERED',
        payment_status: 'PAID',
      });

      const customerView = await request(t.app)
        .get(`/api/orders/${orderId}`)
        .set('authorization', bearer(s.customerId));
      expect(bodyOf(orderDetailResponseSchema, customerView).order.state).toBe('DELIVERED');
    });

    it('settles COD in the same commit: the commission is debited from the vendor wallet', async () => {
      const s = await setup();
      const { orderId, otp } = await outForDelivery(s);
      const revenueBefore = (await balanceOf(db(), 'PLATFORM_REVENUE')) ?? 0;

      expect((await deliver(s.vendorUserId, orderId, otp)).status).toBe(200);

      expect(await settlementsOf(orderId)).toHaveLength(1);
      // SPEC verification 3: 1000 NPR COD at 10% → the wallet is debited 100.
      expect(await balanceOf(db(), { vendorId: s.vendorId })).toBe(-100);
      expect(((await balanceOf(db(), 'PLATFORM_REVENUE')) ?? 0) - revenueBefore).toBeCloseTo(100);
      expect(await vendorStatus(s.vendorId)).toBe('LIVE');
    });

    it('suspends the vendor when the COD commission pushes the wallet below −2000 NPR', async () => {
      const s = await setup('SELF_DELIVERY', 12_500); // 2 × 12 500 → 2 500 commission
      const { orderId, otp } = await outForDelivery(s);

      const res = await deliver(s.vendorUserId, orderId, otp);

      expect(res.status).toBe(200);
      expect(await balanceOf(db(), { vendorId: s.vendorId })).toBe(-2500);
      expect(await vendorStatus(s.vendorId)).toBe('SUSPENDED');
      expect((await rowOf(orderId)).state).toBe('DELIVERED');
    });

    it('releases a prepaid order from escrow: subtotal − commission + delivery fee to the vendor', async () => {
      const s = await setup();
      const { orderId, otp } = await outForDelivery(s, 'ESEWA');

      expect((await deliver(s.vendorUserId, orderId, otp)).status).toBe(200);

      expect(await settlementsOf(orderId)).toHaveLength(1);
      // Step 7.3: held for 7 days after delivery before it reaches the wallet.
      expect(await balanceOf(db(), { holdVendorId: s.vendorId })).toBe(950);
    });

    it('answers a repeated delivery with the same success, settled once', async () => {
      const s = await setup();
      const { orderId, otp } = await outForDelivery(s);

      const first = await deliver(s.vendorUserId, orderId, otp);
      const again = await deliver(s.vendorUserId, orderId, otp);

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
        Array.from({ length: 5 }, () => deliver(s.vendorUserId, orderId, otp)),
      );

      expect(results.map((res) => res.status)).toEqual([200, 200, 200, 200, 200]);
      expect((await transitions(orderId)).filter((e) => e.to_state === 'DELIVERED')).toHaveLength(
        1,
      );
      expect(await settlementsOf(orderId)).toHaveLength(1);
      expect(await balanceOf(db(), { vendorId: s.vendorId })).toBe(-100);
    });

    it('clears the wrong-code counter once delivered', async () => {
      const s = await setup();
      const { orderId, otp } = await outForDelivery(s);
      await deliver(s.vendorUserId, orderId, wrongCode(otp));
      expect(await failureCount(orderId)).toBe('1');

      expect((await deliver(s.vendorUserId, orderId, otp)).status).toBe(200);

      expect(await failureCount(orderId)).toBeNull();
    });
  });

  describe('the SELF_DELIVERY constraint', () => {
    it('refuses a fleet order with 409 WRONG_FULFILLMENT_MODE, even with the right code', async () => {
      const s = await setup('PLATFORM_FLEET');
      const { orderId, otp } = await outForDelivery(s);

      const res = await deliver(s.vendorUserId, orderId, otp);

      expect(res.status).toBe(409);
      expect(errorOf(res)).toMatchObject({
        code: 'WRONG_FULFILLMENT_MODE',
        details: { fulfillment: 'PLATFORM_FLEET' },
      });
      const row = await rowOf(orderId);
      expect(row.state).toBe('OUT_FOR_DELIVERY');
      expect(row.delivery_otp).not.toBeNull();
      expect(await settlementsOf(orderId)).toHaveLength(0);
    });

    it('never counts a code typed for a fleet order, so it cannot lock the rider out', async () => {
      const s = await setup('PLATFORM_FLEET');
      const { orderId, otp } = await outForDelivery(s);

      for (let i = 0; i < 6; i += 1) {
        expect((await deliver(s.vendorUserId, orderId, wrongCode(otp))).status).toBe(409);
      }

      expect(await failureCount(orderId)).toBeNull();
      const rider = await createUser(db(), 'DRIVER');
      const [delivery] = await db()
        .select()
        .from(deliveries)
        .where(eq(deliveries.order_id, orderId));
      const riderPost = (action: string) =>
        request(t.app)
          .post(`/api/deliveries/${delivery?.id ?? ''}/${action}`)
          .set('authorization', bearer(rider, 'DRIVER'));
      expect((await riderPost('accept')).status).toBe(200);
      expect((await riderPost('pickup')).status).toBe(200);
      expect((await riderPost('complete').send({ delivery_otp: otp })).status).toBe(200);
    });

    it('refuses an EMERGENCY_FLEET order too (the platform rider delivers it)', async () => {
      const s = await setup();
      const { orderId, otp } = await outForDelivery(s);
      await db()
        .update(orders)
        .set({ fulfillment_locked: 'EMERGENCY_FLEET' })
        .where(eq(orders.id, orderId));

      const res = await deliver(s.vendorUserId, orderId, otp);

      expect(res.status).toBe(409);
      expect(errorOf(res).details).toEqual({ fulfillment: 'EMERGENCY_FLEET' });
    });

    it('keeps SELF_DELIVERY orders away from the platform riders (no delivery, not listed)', async () => {
      const s = await setup();
      const { orderId } = await outForDelivery(s);
      const rider = await createUser(db(), 'DRIVER');

      const res = await request(t.app)
        .get('/api/deliveries')
        .set('authorization', bearer(rider, 'DRIVER'));

      expect(await db().select().from(deliveries).where(eq(deliveries.order_id, orderId))).toEqual(
        [],
      );
      const listed = bodyOf(deliveryListResponseSchema, res).deliveries;
      expect(listed.map((delivery) => delivery.order.id)).not.toContain(orderId);
      expect((await rowOf(orderId)).state).toBe('OUT_FOR_DELIVERY');
    });
  });

  describe('wrong codes and the Redis lockout', () => {
    it('denies a wrong code with 401 INVALID_OTP and changes nothing', async () => {
      const s = await setup();
      const { orderId, otp } = await outForDelivery(s);
      const before = await rowOf(orderId);

      const res = await deliver(s.vendorUserId, orderId, wrongCode(otp));

      expect(res.status).toBe(401);
      expect(errorOf(res)).toMatchObject({
        code: 'INVALID_OTP',
        details: { attempts_remaining: 4 },
      });
      const after = await rowOf(orderId);
      expect(after.state).toBe('OUT_FOR_DELIVERY');
      expect(after.delivery_otp).toBe(before.delivery_otp);
      expect(await settlementsOf(orderId)).toHaveLength(0);
    });

    it('counts down, locks on the 5th wrong code, and then refuses even the right one', async () => {
      const s = await setup();
      const { orderId, otp } = await outForDelivery(s);
      const wrong = wrongCode(otp);

      const remaining: unknown[] = [];
      for (let i = 0; i < 4; i += 1) {
        const res = await deliver(s.vendorUserId, orderId, wrong);
        expect(res.status).toBe(401);
        remaining.push(errorOf(res).details);
      }
      expect(remaining).toEqual([4, 3, 2, 1].map((left) => ({ attempts_remaining: left })));

      const fifth = await deliver(s.vendorUserId, orderId, wrong);
      expect(fifth.status).toBe(429);
      const locked = errorOf(fifth);
      expect(locked.code).toBe('DELIVERY_OTP_LOCKED');
      const retryAfter = (locked.details as { retry_after_seconds: number }).retry_after_seconds;
      expect(retryAfter).toBeGreaterThan(DELIVERY_OTP_LOCKOUT_SECONDS - 10);
      expect(retryAfter).toBeLessThanOrEqual(DELIVERY_OTP_LOCKOUT_SECONDS);

      const right = await deliver(s.vendorUserId, orderId, otp);
      expect(right.status).toBe(429);
      expect((await rowOf(orderId)).state).toBe('OUT_FOR_DELIVERY');
      expect(await failureCount(orderId)).toBe('5');
    });

    it('lets no concurrent guess past the limit: 10 at once → four 401s, six 429s', async () => {
      const s = await setup();
      const { orderId, otp } = await outForDelivery(s);

      const results = await Promise.all(
        Array.from({ length: 10 }, () => deliver(s.vendorUserId, orderId, wrongCode(otp))),
      );

      const statuses = results.map((res) => res.status).sort();
      expect(statuses).toEqual([401, 401, 401, 401, 429, 429, 429, 429, 429, 429]);
      expect(await failureCount(orderId)).toBe('5');
    });

    it('accepts the right code again once the lockout has run out', async () => {
      const short = buildTestApp({ deliveryOtpLockoutMs: 400 });
      try {
        const s = await setup();
        const { orderId, otp } = await outForDelivery(s);
        for (let i = 0; i < 5; i += 1) {
          await deliver(s.vendorUserId, orderId, wrongCode(otp), 'VENDOR', short.app);
        }
        expect((await deliver(s.vendorUserId, orderId, otp, 'VENDOR', short.app)).status).toBe(429);

        await new Promise((resolve) => setTimeout(resolve, 600));

        expect((await deliver(s.vendorUserId, orderId, otp, 'VENDOR', short.app)).status).toBe(200);
      } finally {
        await short.container.close();
      }
    });
  });

  describe('state, ownership and authentication', () => {
    it('refuses an order that is not out for delivery with 409, without counting an attempt', async () => {
      const s = await setup();
      const { orderId, otp } = await checkout(s);
      await vendorPost(s, orderId, 'accept');

      const res = await deliver(s.vendorUserId, orderId, otp);

      expect(res.status).toBe(409);
      expect(errorOf(res)).toMatchObject({
        code: 'ORDER_STATE_CONFLICT',
        details: { state: 'PREPARING' },
      });
      expect(await failureCount(orderId)).toBeNull();
    });

    it("answers 404 for another vendor's order and for unknown ids", async () => {
      const s = await setup();
      const { orderId, otp } = await outForDelivery(s);
      const other = await setup();

      const foreign = await deliver(other.vendorUserId, orderId, otp);
      const unknown = await deliver(s.vendorUserId, randomUUID(), otp);

      for (const res of [foreign, unknown]) {
        expect(res.status).toBe(404);
        expect(errorOf(res).code).toBe('ORDER_NOT_FOUND');
      }
      expect(await failureCount(orderId)).toBeNull();
      expect((await rowOf(orderId)).state).toBe('OUT_FOR_DELIVERY');
    });

    it('requires a VENDOR token', async () => {
      const s = await setup();
      const { orderId, otp } = await outForDelivery(s);

      const anonymous = await request(t.app)
        .post(`/api/vendors/orders/${orderId}/deliver`)
        .send({ delivery_otp: otp });
      const customer = await deliver(s.customerId, orderId, otp, 'CUSTOMER');
      const driver = await deliver(await createUser(db(), 'DRIVER'), orderId, otp, 'DRIVER');

      expect(anonymous.status).toBe(401);
      expect(customer.status).toBe(403);
      expect(driver.status).toBe(403);
      expect((await rowOf(orderId)).state).toBe('OUT_FOR_DELIVERY');
    });

    it('validates the id and the code format before looking at the order', async () => {
      const s = await setup();
      const { orderId } = await outForDelivery(s);

      const results = await Promise.all([
        deliver(s.vendorUserId, 'not-a-uuid', '1234'),
        ...['123', '12345', '12a4', 1234, undefined].map((code) =>
          deliver(s.vendorUserId, orderId, code),
        ),
      ]);

      for (const res of results) {
        expect(res.status).toBe(400);
        expect(errorOf(res).code).toBe('VALIDATION_FAILED');
      }
      expect(await failureCount(orderId)).toBeNull();
    });
  });

  describe('GET /api/vendors/orders', () => {
    it('lists the shop’s own deliveries on the road after new and preparing orders', async () => {
      const s = await setup();
      const onTheRoad = await outForDelivery(s);
      const preparing = await checkout(s);
      await vendorPost(s, preparing.orderId, 'accept');
      const placed = await checkout(s);

      const res = await request(t.app)
        .get('/api/vendors/orders')
        .set('authorization', bearer(s.vendorUserId, 'VENDOR'));

      const listed = bodyOf(vendorOrderListResponseSchema, res).orders;
      expect(listed.map((order) => [order.id, order.state])).toEqual([
        [placed.orderId, 'PLACED'],
        [preparing.orderId, 'PREPARING'],
        [onTheRoad.orderId, 'OUT_FOR_DELIVERY'],
      ]);
      expect(JSON.stringify(res.body)).not.toContain('delivery_otp');
    });

    it('leaves out fleet orders on the road (the rider has them) and delivered orders', async () => {
      const fleet = await setup('PLATFORM_FLEET');
      const fleetOrder = await outForDelivery(fleet);
      const s = await setup();
      const delivered = await outForDelivery(s);
      await deliver(s.vendorUserId, delivered.orderId, delivered.otp);

      const list = async (vendor: Setup) =>
        bodyOf(
          vendorOrderListResponseSchema,
          await request(t.app)
            .get('/api/vendors/orders')
            .set('authorization', bearer(vendor.vendorUserId, 'VENDOR')),
        ).orders.map((order) => order.id);

      expect(await list(fleet)).not.toContain(fleetOrder.orderId);
      expect(await list(s)).not.toContain(delivered.orderId);
    });
  });
});
