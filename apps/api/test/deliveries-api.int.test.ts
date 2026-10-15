import { randomUUID } from 'node:crypto';

import { deliveries, ledgerTransactions, orders } from '@hamro-pasal/db';
import {
  checkoutResponseSchema,
  DELIVERY_OTP_LOCKOUT_SECONDS,
  deliveryConfirmedResponseSchema,
  deliveryListResponseSchema,
  deliveryResponseSchema,
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

type Role = 'DRIVER' | 'CUSTOMER' | 'VENDOR';

/**
 * Phase 21 (replacing Phase 11's /api/driver/orders): a dispatched fleet order becomes a delivery
 * that a platform rider accepts, picks up and completes with the customer's 4-digit code
 * (delivery partner flow, customer journey 10), over real Express + PostgreSQL + Redis. A matching
 * code delivers, erases the hash and settles escrow in one commit; wrong codes are counted in
 * Redis and the fifth locks the order. Only the rider who accepted a delivery can complete it.
 */
describe('deliveries API', () => {
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
    const productId = await createProduct(db(), vendorId, 20, 500);
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

  const vendorPost = (s: Setup, orderId: string, action: 'accept' | 'dispatch') =>
    request(t.app)
      .post(`/api/vendors/orders/${orderId}/${action}`)
      .set('authorization', bearer(s.vendorUserId, 'VENDOR'));

  async function deliveryRowsOf(orderId: string) {
    return db().select().from(deliveries).where(eq(deliveries.order_id, orderId));
  }

  async function deliveryOf(orderId: string) {
    const [row] = await deliveryRowsOf(orderId);
    if (row === undefined) throw new Error(`order ${orderId} has no delivery`);
    return row;
  }

  /** A real order walked through the API to OUT_FOR_DELIVERY: an open gig for a fleet shop. */
  async function dispatched(s: Setup, paymentMethod: 'COD' | 'ESEWA' = 'COD') {
    const placed = await checkout(s, paymentMethod);
    if (paymentMethod === 'ESEWA') await payByEsewa(s.customerId, placed.orderId);
    expect((await vendorPost(s, placed.orderId, 'accept')).status).toBe(200);
    await backdatePlacement(db(), placed.orderId, 61); // past the customer's 60 s window
    expect((await vendorPost(s, placed.orderId, 'dispatch')).status).toBe(200);
    return placed;
  }

  /** As `dispatched`, with the gig's delivery id. */
  async function offered(s: Setup, paymentMethod: 'COD' | 'ESEWA' = 'COD') {
    const placed = await dispatched(s, paymentMethod);
    return { ...placed, deliveryId: (await deliveryOf(placed.orderId)).id };
  }

  const step = (
    action: 'accept' | 'pickup',
    userId: string,
    deliveryId: string,
    role: Role = 'DRIVER',
  ) =>
    request(t.app)
      .post(`/api/deliveries/${deliveryId}/${action}`)
      .set('authorization', bearer(userId, role));

  /** A delivery the setup's rider accepted and picked up: ready for the code at the door. */
  async function atTheDoor(s: Setup, paymentMethod: 'COD' | 'ESEWA' = 'COD') {
    const gig = await offered(s, paymentMethod);
    expect((await step('accept', s.driverId, gig.deliveryId)).status).toBe(200);
    expect((await step('pickup', s.driverId, gig.deliveryId)).status).toBe(200);
    return gig;
  }

  const complete = (
    userId: string,
    deliveryId: string,
    otp: unknown,
    role: Role = 'DRIVER',
    app = t.app,
  ) =>
    request(app)
      .post(`/api/deliveries/${deliveryId}/complete`)
      .set('authorization', bearer(userId, role))
      .send({ delivery_otp: otp });

  const list = (userId: string, role: Role = 'DRIVER') =>
    request(t.app).get('/api/deliveries').set('authorization', bearer(userId, role));

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

  describe('dispatch opens the gig', () => {
    it('creates one OFFERED delivery without a rider when a fleet order is dispatched', async () => {
      const s = await setup();
      const { orderId } = await dispatched(s);

      const rows = await deliveryRowsOf(orderId);

      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        order_id: orderId,
        state: 'OFFERED',
        rider_id: null,
        accepted_at: null,
        picked_up_at: null,
        completed_at: null,
      });
      expect((await rowOf(orderId)).driver_user_id).toBeNull();
    });

    it('keeps one delivery when the dispatch is repeated', async () => {
      const s = await setup();
      const { orderId } = await dispatched(s);

      expect((await vendorPost(s, orderId, 'dispatch')).status).toBe(200);

      expect(await deliveryRowsOf(orderId)).toHaveLength(1);
    });

    it("opens no gig for a SELF_DELIVERY order (the shop's own staff carry it)", async () => {
      const s = await setup('SELF_DELIVERY');
      const { orderId } = await dispatched(s);

      expect(await deliveryRowsOf(orderId)).toHaveLength(0);
    });

    it('opens none before dispatch', async () => {
      const s = await setup();
      const { orderId } = await checkout(s);
      await vendorPost(s, orderId, 'accept');

      expect(await deliveryRowsOf(orderId)).toHaveLength(0);
    });
  });

  describe('POST /api/deliveries/:id/accept', () => {
    it('assigns the gig to the rider and records them on the order', async () => {
      const s = await setup();
      const { orderId, deliveryId } = await offered(s);

      const res = await step('accept', s.driverId, deliveryId);

      expect(res.status).toBe(200);
      const { delivery } = bodyOf(deliveryResponseSchema, res);
      expect(delivery).toMatchObject({
        id: deliveryId,
        state: 'ASSIGNED',
        assigned_to_me: true,
        picked_up_at: null,
        order: { id: orderId, state: 'OUT_FOR_DELIVERY', total_npr: 1050 },
      });
      const row = await deliveryOf(orderId);
      expect(row).toMatchObject({ state: 'ASSIGNED', rider_id: s.driverId });
      expect(delivery.accepted_at).toBe(row.accepted_at?.toISOString());
      expect((await rowOf(orderId)).driver_user_id).toBe(s.driverId);
      // Accepting changes no order state: nothing is announced.
      expect((await transitions(orderId)).at(-1)?.to_state).toBe('OUT_FOR_DELIVERY');
    });

    it('answers the same rider again with the same delivery', async () => {
      const s = await setup();
      const { deliveryId } = await offered(s);

      const first = await step('accept', s.driverId, deliveryId);
      const again = await step('accept', s.driverId, deliveryId);

      expect(again.status).toBe(200);
      expect(again.body).toEqual(first.body);
    });

    it('refuses a second rider with 409 DELIVERY_ALREADY_ASSIGNED and keeps the first', async () => {
      const s = await setup();
      const { orderId, deliveryId } = await offered(s);
      await step('accept', s.driverId, deliveryId);
      const otherRider = await createUser(db(), 'DRIVER');

      const res = await step('accept', otherRider, deliveryId);

      expect(res.status).toBe(409);
      expect(errorOf(res).code).toBe('DELIVERY_ALREADY_ASSIGNED');
      expect((await deliveryOf(orderId)).rider_id).toBe(s.driverId);
      expect((await rowOf(orderId)).driver_user_id).toBe(s.driverId);
    });

    it('lets exactly one of 5 riders accepting at once win', async () => {
      const s = await setup();
      const { orderId, deliveryId } = await offered(s);
      const riders = await Promise.all(Array.from({ length: 5 }, () => createUser(db(), 'DRIVER')));

      const results = await Promise.all(riders.map((rider) => step('accept', rider, deliveryId)));

      expect(results.map((res) => res.status).sort()).toEqual([200, 409, 409, 409, 409]);
      const winner = riders[results.findIndex((res) => res.status === 200)];
      expect((await deliveryOf(orderId)).rider_id).toBe(winner);
      expect((await rowOf(orderId)).driver_user_id).toBe(winner);
    });

    it('answers 404 DELIVERY_NOT_FOUND for an unknown id and 400 for a malformed one', async () => {
      const s = await setup();

      const unknown = await step('accept', s.driverId, randomUUID());
      const malformed = await step('accept', s.driverId, 'not-a-uuid');

      expect(unknown.status).toBe(404);
      expect(errorOf(unknown).code).toBe('DELIVERY_NOT_FOUND');
      expect(malformed.status).toBe(400);
      expect(errorOf(malformed).code).toBe('VALIDATION_FAILED');
    });

    it('requires a DRIVER token', async () => {
      const s = await setup();
      const { orderId, deliveryId } = await offered(s);

      const anonymous = await request(t.app).post(`/api/deliveries/${deliveryId}/accept`);
      const customer = await step('accept', s.customerId, deliveryId, 'CUSTOMER');
      const vendor = await step('accept', s.vendorUserId, deliveryId, 'VENDOR');

      expect(anonymous.status).toBe(401);
      expect(customer.status).toBe(403);
      expect(vendor.status).toBe(403);
      expect((await deliveryOf(orderId)).state).toBe('OFFERED');
    });
  });

  describe('POST /api/deliveries/:id/pickup', () => {
    it('moves the rider’s own delivery to PICKED_UP, once', async () => {
      const s = await setup();
      const { orderId, deliveryId } = await offered(s);
      await step('accept', s.driverId, deliveryId);

      const first = await step('pickup', s.driverId, deliveryId);
      const again = await step('pickup', s.driverId, deliveryId);

      expect(first.status).toBe(200);
      const { delivery } = bodyOf(deliveryResponseSchema, first);
      expect(delivery.state).toBe('PICKED_UP');
      expect(delivery.picked_up_at).not.toBeNull();
      expect(again.status).toBe(200);
      expect(again.body).toEqual(first.body);
      expect((await deliveryOf(orderId)).state).toBe('PICKED_UP');
    });

    it('hides an open gig and another rider’s delivery (404, nothing changed)', async () => {
      const s = await setup();
      const open = await offered(s);
      const taken = await offered(s);
      const otherRider = await createUser(db(), 'DRIVER');
      await step('accept', otherRider, taken.deliveryId);

      const results = [
        await step('pickup', s.driverId, open.deliveryId),
        await step('pickup', s.driverId, taken.deliveryId),
      ];

      for (const res of results) {
        expect(res.status).toBe(404);
        expect(errorOf(res).code).toBe('DELIVERY_NOT_FOUND');
      }
      expect((await deliveryOf(open.orderId)).state).toBe('OFFERED');
      expect((await deliveryOf(taken.orderId)).state).toBe('ASSIGNED');
    });
  });

  describe('POST /api/deliveries/:id/complete with the right code', () => {
    it('delivers, stamps delivered_at, erases the hash, closes the delivery and announces it', async () => {
      const s = await setup();
      const { orderId, otp, deliveryId } = await atTheDoor(s);

      const res = await complete(s.driverId, deliveryId, otp);

      expect(res.status).toBe(200);
      const body = bodyOf(deliveryConfirmedResponseSchema, res);
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

      const delivery = await deliveryOf(orderId);
      expect(delivery).toMatchObject({ state: 'DELIVERED', rider_id: s.driverId });
      expect(delivery.completed_at).not.toBeNull();

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
      const { orderId, otp, deliveryId } = await atTheDoor(s);
      const revenueBefore = (await balanceOf(db(), 'PLATFORM_REVENUE')) ?? 0;

      expect((await complete(s.driverId, deliveryId, otp)).status).toBe(200);

      expect(await settlementsOf(orderId)).toHaveLength(1);
      // Cash 1050 collected, delivery fee 50 earned: net −1000 on the rider's float.
      expect(await balanceOf(db(), { driverUserId: s.driverId })).toBe(-1000);
      // 10% commission of 1000 to the platform, 900 to the vendor.
      expect(await balanceOf(db(), { vendorId: s.vendorId })).toBe(900);
      expect(((await balanceOf(db(), 'PLATFORM_REVENUE')) ?? 0) - revenueBefore).toBeCloseTo(100);
    });

    it('releases a prepaid order from escrow to vendor, rider and platform', async () => {
      const s = await setup();
      const { orderId, otp, deliveryId } = await atTheDoor(s, 'ESEWA');

      expect((await complete(s.driverId, deliveryId, otp)).status).toBe(200);

      expect(await settlementsOf(orderId)).toHaveLength(1);
      expect(await balanceOf(db(), { driverUserId: s.driverId })).toBe(50);
      // Step 7.3: a delivered prepaid order is credited to the dispute hold for 7 days.
      expect(await balanceOf(db(), { holdVendorId: s.vendorId })).toBe(900);
      expect(await balanceOf(db(), { vendorId: s.vendorId })).toBe(0);
    });

    it('answers a retry by the same rider with the same success, once in the ledger', async () => {
      const s = await setup();
      const { orderId, otp, deliveryId } = await atTheDoor(s);

      const first = await complete(s.driverId, deliveryId, otp);
      const again = await complete(s.driverId, deliveryId, otp);

      expect(again.status).toBe(200);
      expect(again.body).toEqual(first.body);
      expect((await transitions(orderId)).filter((e) => e.to_state === 'DELIVERED')).toHaveLength(
        1,
      );
      expect(await settlementsOf(orderId)).toHaveLength(1);
    });

    it('delivers exactly once when the right code is submitted 5 times at once', async () => {
      const s = await setup();
      const { orderId, otp, deliveryId } = await atTheDoor(s);

      const results = await Promise.all(
        Array.from({ length: 5 }, () => complete(s.driverId, deliveryId, otp)),
      );

      expect(results.map((res) => res.status)).toEqual([200, 200, 200, 200, 200]);
      expect((await transitions(orderId)).filter((e) => e.to_state === 'DELIVERED')).toHaveLength(
        1,
      );
      expect(await settlementsOf(orderId)).toHaveLength(1);
      expect(await balanceOf(db(), { driverUserId: s.driverId })).toBe(-1000);
    });

    it('clears the wrong-code counter once delivered', async () => {
      const s = await setup();
      const { orderId, otp, deliveryId } = await atTheDoor(s);
      await complete(s.driverId, deliveryId, wrongCode(otp));
      expect(await failureCount(orderId)).toBe('1');

      expect((await complete(s.driverId, deliveryId, otp)).status).toBe(200);

      expect(await failureCount(orderId)).toBeNull();
    });
  });

  describe('the delivery constraints on the order state machine', () => {
    it('refuses the right code before pickup with 409, without counting an attempt', async () => {
      const s = await setup();
      const { orderId, otp, deliveryId } = await offered(s);
      await step('accept', s.driverId, deliveryId);

      const res = await complete(s.driverId, deliveryId, otp);

      expect(res.status).toBe(409);
      expect(errorOf(res)).toMatchObject({
        code: 'DELIVERY_STATE_CONFLICT',
        details: { state: 'ASSIGNED' },
      });
      expect(await failureCount(orderId)).toBeNull();
      expect((await rowOf(orderId)).state).toBe('OUT_FOR_DELIVERY');
    });

    it('refuses the right code from a rider who never accepted the gig (404)', async () => {
      const s = await setup();
      const { orderId, otp, deliveryId } = await offered(s);

      const res = await complete(s.driverId, deliveryId, otp);

      expect(res.status).toBe(404);
      expect(errorOf(res).code).toBe('DELIVERY_NOT_FOUND');
      expect(await failureCount(orderId)).toBeNull();
      expect((await rowOf(orderId)).state).toBe('OUT_FOR_DELIVERY');
    });

    it('refuses the right code from every rider but the one who accepted', async () => {
      const s = await setup();
      const { orderId, otp, deliveryId } = await atTheDoor(s);
      const otherRider = await createUser(db(), 'DRIVER');

      const before = await complete(otherRider, deliveryId, otp);
      expect((await complete(s.driverId, deliveryId, otp)).status).toBe(200);
      const after = await complete(otherRider, deliveryId, otp);

      for (const res of [before, after]) {
        expect(res.status).toBe(404);
        expect(errorOf(res).code).toBe('DELIVERY_NOT_FOUND');
      }
      expect((await rowOf(orderId)).driver_user_id).toBe(s.driverId);
      expect(await settlementsOf(orderId)).toHaveLength(1);
    });

    it('no longer serves the Phase 11 rider routes', async () => {
      const s = await setup();
      const { orderId, otp } = await dispatched(s);

      const oldDeliver = await request(t.app)
        .post(`/api/driver/orders/${orderId}/deliver`)
        .set('authorization', bearer(s.driverId, 'DRIVER'))
        .send({ delivery_otp: otp });
      const oldList = await request(t.app)
        .get('/api/driver/orders')
        .set('authorization', bearer(s.driverId, 'DRIVER'));

      expect(oldDeliver.status).toBe(404);
      expect(oldList.status).toBe(404);
      expect((await rowOf(orderId)).state).toBe('OUT_FOR_DELIVERY');
    });

    it('keeps the table consistent by itself (CHECK and unique constraints)', async () => {
      const s = await setup();
      const { orderId } = await dispatched(s);

      // A second delivery for the order.
      await expect(db().insert(deliveries).values({ order_id: orderId })).rejects.toMatchObject({
        cause: expect.objectContaining({ constraint: 'deliveries_order_id_uidx' }) as unknown,
      });
      // A rider on an open gig, an assignment without a rider, a delivery that skipped pickup.
      await expect(
        db()
          .update(deliveries)
          .set({ rider_id: s.driverId })
          .where(eq(deliveries.order_id, orderId)),
      ).rejects.toMatchObject({
        cause: expect.objectContaining({ constraint: 'deliveries_rider_check' }) as unknown,
      });
      await expect(
        db()
          .update(deliveries)
          .set({ state: 'ASSIGNED', accepted_at: new Date() })
          .where(eq(deliveries.order_id, orderId)),
      ).rejects.toMatchObject({
        cause: expect.objectContaining({ constraint: 'deliveries_rider_check' }) as unknown,
      });
      await expect(
        db()
          .update(deliveries)
          .set({
            state: 'DELIVERED',
            rider_id: s.driverId,
            accepted_at: new Date(),
            completed_at: new Date(),
          })
          .where(eq(deliveries.order_id, orderId)),
      ).rejects.toMatchObject({
        cause: expect.objectContaining({
          constraint: 'deliveries_delivered_picked_up_check',
        }) as unknown,
      });
    });
  });

  describe('wrong codes and the lockout', () => {
    it('denies a wrong code with 401 INVALID_OTP and changes nothing', async () => {
      const s = await setup();
      const { orderId, otp, deliveryId } = await atTheDoor(s);
      const before = await rowOf(orderId);

      const res = await complete(s.driverId, deliveryId, wrongCode(otp));

      expect(res.status).toBe(401);
      expect(errorOf(res)).toMatchObject({
        code: 'INVALID_OTP',
        details: { attempts_remaining: 4 },
      });
      const after = await rowOf(orderId);
      expect(after.state).toBe('OUT_FOR_DELIVERY');
      expect(after.delivery_otp).toBe(before.delivery_otp);
      expect(after.delivered_at).toBeNull();
      expect((await deliveryOf(orderId)).state).toBe('PICKED_UP');
      expect(await settlementsOf(orderId)).toHaveLength(0);
    });

    it('denies every code but the one issued (neighbours, reversed, zero-padded)', async () => {
      const s = await setup();
      const { orderId, otp, deliveryId } = await atTheDoor(s);
      const n = Number(otp);
      const near = [
        String((n + 1) % 10_000).padStart(4, '0'),
        String((n + 9_999) % 10_000).padStart(4, '0'),
        otp.split('').reverse().join(''),
      ].filter((code) => code !== otp);

      for (const code of near) {
        expect((await complete(s.driverId, deliveryId, code)).status).toBe(401);
      }
      expect((await rowOf(orderId)).state).toBe('OUT_FOR_DELIVERY');
    });

    it('counts down, locks on the 5th wrong code, and then refuses even the right one', async () => {
      const s = await setup();
      const { orderId, otp, deliveryId } = await atTheDoor(s);
      const wrong = wrongCode(otp);

      const remaining: unknown[] = [];
      for (let i = 0; i < 4; i += 1) {
        const res = await complete(s.driverId, deliveryId, wrong);
        expect(res.status).toBe(401);
        remaining.push(errorOf(res).details);
      }
      expect(remaining).toEqual([4, 3, 2, 1].map((left) => ({ attempts_remaining: left })));

      const fifth = await complete(s.driverId, deliveryId, wrong);
      expect(fifth.status).toBe(429);
      const locked = errorOf(fifth);
      expect(locked.code).toBe('DELIVERY_OTP_LOCKED');
      const retryAfter = (locked.details as { retry_after_seconds: number }).retry_after_seconds;
      expect(retryAfter).toBeGreaterThan(DELIVERY_OTP_LOCKOUT_SECONDS - 10);
      expect(retryAfter).toBeLessThanOrEqual(DELIVERY_OTP_LOCKOUT_SECONDS);

      const right = await complete(s.driverId, deliveryId, otp);
      expect(right.status).toBe(429);
      expect(errorOf(right).code).toBe('DELIVERY_OTP_LOCKED');
      const row = await rowOf(orderId);
      expect(row.state).toBe('OUT_FOR_DELIVERY');
      expect(row.delivery_otp).not.toBeNull();
      expect((await deliveryOf(orderId)).state).toBe('PICKED_UP');
    });

    it('lets no concurrent guess past the limit: 10 at once → four 401s, six 429s', async () => {
      const s = await setup();
      const { orderId, otp, deliveryId } = await atTheDoor(s);

      const results = await Promise.all(
        Array.from({ length: 10 }, () => complete(s.driverId, deliveryId, wrongCode(otp))),
      );

      const statuses = results.map((res) => res.status).sort();
      expect(statuses).toEqual([401, 401, 401, 401, 429, 429, 429, 429, 429, 429]);
      expect(await failureCount(orderId)).toBe('5');
    });

    it('keeps the lockout per order: another delivery of the rider is unaffected', async () => {
      const s = await setup();
      const first = await atTheDoor(s);
      const second = await atTheDoor(s);
      for (let i = 0; i < 5; i += 1) {
        await complete(s.driverId, first.deliveryId, wrongCode(first.otp));
      }

      expect((await complete(s.driverId, second.deliveryId, second.otp)).status).toBe(200);
    });

    it('accepts the right code again once the lockout has run out', async () => {
      const short = buildTestApp({ deliveryOtpLockoutMs: 400 });
      try {
        const s = await setup();
        const { otp, deliveryId } = await atTheDoor(s);
        for (let i = 0; i < 5; i += 1) {
          await complete(s.driverId, deliveryId, wrongCode(otp), 'DRIVER', short.app);
        }
        expect((await complete(s.driverId, deliveryId, otp, 'DRIVER', short.app)).status).toBe(429);

        await new Promise((resolve) => setTimeout(resolve, 600));

        expect((await complete(s.driverId, deliveryId, otp, 'DRIVER', short.app)).status).toBe(200);
      } finally {
        await short.container.close();
      }
    });

    it('requires a DRIVER token', async () => {
      const s = await setup();
      const { orderId, otp, deliveryId } = await atTheDoor(s);

      const anonymous = await request(t.app)
        .post(`/api/deliveries/${deliveryId}/complete`)
        .send({ delivery_otp: otp });
      const customer = await complete(s.customerId, deliveryId, otp, 'CUSTOMER');
      const vendor = await complete(s.vendorUserId, deliveryId, otp, 'VENDOR');

      expect(anonymous.status).toBe(401);
      expect(errorOf(anonymous).code).toBe('UNAUTHENTICATED');
      for (const res of [customer, vendor]) {
        expect(res.status).toBe(403);
        expect(errorOf(res).code).toBe('FORBIDDEN');
      }
      expect((await rowOf(orderId)).state).toBe('OUT_FOR_DELIVERY');
    });

    it('validates the id and the code format before looking at the delivery', async () => {
      const s = await setup();
      const { orderId, deliveryId } = await atTheDoor(s);

      const badId = await complete(s.driverId, 'not-a-uuid', '1234');
      const results = await Promise.all(
        ['123', '12345', '12a4', 1234, undefined].map((code) =>
          complete(s.driverId, deliveryId, code),
        ),
      );

      for (const res of [badId, ...results]) {
        expect(res.status).toBe(400);
        expect(errorOf(res).code).toBe('VALIDATION_FAILED');
      }
      expect(await failureCount(orderId)).toBeNull();
    });
  });

  describe('GET /api/deliveries', () => {
    it("lists open gigs and the rider's own deliveries, not other riders'", async () => {
      const s = await setup();
      const open = await offered(s);
      const mine = await offered(s);
      const pickedUp = await atTheDoor(s);
      const someoneElses = await offered(s);
      const preparing = await checkout(s);
      await vendorPost(s, preparing.orderId, 'accept');
      const otherRider = await createUser(db(), 'DRIVER');
      await step('accept', s.driverId, mine.deliveryId);
      await step('accept', otherRider, someoneElses.deliveryId);
      const selfDelivery = await setup('SELF_DELIVERY');
      const selfOrder = await dispatched(selfDelivery);

      const res = await list(s.driverId);

      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
      const listed = bodyOf(deliveryListResponseSchema, res).deliveries;
      const byId = new Map(listed.map((delivery) => [delivery.id, delivery]));
      const orderIds = listed.map((delivery) => delivery.order.id);
      expect(byId.get(open.deliveryId)).toMatchObject({ state: 'OFFERED', assigned_to_me: false });
      expect(byId.get(mine.deliveryId)).toMatchObject({ state: 'ASSIGNED', assigned_to_me: true });
      expect(byId.get(pickedUp.deliveryId)).toMatchObject({
        state: 'PICKED_UP',
        assigned_to_me: true,
      });
      expect(byId.has(someoneElses.deliveryId)).toBe(false);
      expect(orderIds).not.toContain(preparing.orderId);
      expect(orderIds).not.toContain(selfOrder.orderId);

      expect(byId.get(open.deliveryId)?.order).toMatchObject({
        id: open.orderId,
        state: 'OUT_FOR_DELIVERY',
        payment_method: 'COD',
        fulfillment: 'PLATFORM_FLEET',
        total_npr: 1050,
        vendor_business_name: 'Patan Organic Store',
        delivery_address: { ward_number: 26, tole_locality: 'Thamel' },
        items: [{ product_id: s.productId, quantity: 2, unit_price_npr: 500 }],
      });
    });

    it('drops a delivery from the list once it is completed', async () => {
      const s = await setup();
      const { otp, deliveryId } = await atTheDoor(s);
      await complete(s.driverId, deliveryId, otp);

      const listed = bodyOf(deliveryListResponseSchema, await list(s.driverId)).deliveries;

      expect(listed.map((delivery) => delivery.id)).not.toContain(deliveryId);
    });

    it("never exposes the customer's identity, another rider or the code's hash", async () => {
      const s = await setup();
      const { deliveryId } = await offered(s);
      await step('accept', s.driverId, deliveryId);

      const raw = JSON.stringify((await list(s.driverId)).body);

      expect(raw).not.toContain('customer_id');
      expect(raw).not.toContain(s.customerId);
      expect(raw).not.toContain('rider_id');
      expect(raw).not.toContain('delivery_otp');
      expect(raw).not.toContain('$2');
      expect(raw).not.toContain('+977');
    });

    it('requires a DRIVER token', async () => {
      const s = await setup();

      expect((await list(s.customerId, 'CUSTOMER')).status).toBe(403);
      expect((await list(s.vendorUserId, 'VENDOR')).status).toBe(403);
      expect((await request(t.app).get('/api/deliveries')).status).toBe(401);
    });
  });
});
