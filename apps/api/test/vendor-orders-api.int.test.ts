import { randomUUID } from 'node:crypto';

import { orders } from '@hamro-pasal/db';
import {
  cancelOrderResponseSchema,
  checkoutResponseSchema,
  domainEventSchema,
  esewaInitiateResponseSchema,
  orderStateChangedPayloadSchema,
  paymentStatusResponseSchema,
  vendorOrderDecisionResponseSchema,
  vendorOrderListResponseSchema,
} from '@hamro-pasal/shared-types';
import { eq } from 'drizzle-orm';
import request from 'supertest';

import {
  backdatePlacement,
  createProduct,
  createUser,
  createVendor,
  DELIVERY_ADDRESS,
  markDelivered,
  outboxFor,
  stockOf,
  vendorUserIdOf,
} from './support/fixtures';
import { bearer, bodyOf, buildTestApp, esewaCallback, errorOf, type TestApp } from './support/http';

/**
 * Phase 10: the vendor's order routes (vendor flow steps 6–7) over real Express + PostgreSQL +
 * Redis. Accept moves PLACED → PREPARING, reject cancels with the customer cancellation's effects
 * (stock back, escrow refund flag for prepaid orders), and both announce `order.state_changed`.
 */
describe('vendor orders API', () => {
  let t: TestApp;

  beforeAll(() => {
    t = buildTestApp();
  });

  afterAll(async () => {
    await t.container.close();
  });

  const db = () => t.container.db;

  async function setup(stock = 10) {
    const customerId = await createUser(db());
    const vendorId = await createVendor(db(), { baseDeliveryFee: 50 });
    const vendorUserId = await vendorUserIdOf(db(), vendorId);
    const productId = await createProduct(db(), vendorId, stock, 500);
    return { customerId, vendorId, vendorUserId, productId };
  }

  async function checkout(
    customerId: string,
    vendorId: string,
    productId: string,
    paymentMethod: 'COD' | 'ESEWA' = 'COD',
  ) {
    const res = await request(t.app)
      .post('/api/cart/checkout')
      .set('authorization', bearer(customerId))
      .send({
        idempotency_key: randomUUID(),
        vendor_id: vendorId,
        payment_method: paymentMethod,
        items: [{ product_id: productId, quantity: 2 }],
        delivery_address: DELIVERY_ADDRESS,
      });
    expect(res.status).toBe(201);
    return bodyOf(checkoutResponseSchema, res).order;
  }

  /** Checkout by eSewa and complete the payment: the order is PLACED and PAID (1050 NPR). */
  async function paidEsewaOrder(customerId: string, vendorId: string, productId: string) {
    const order = await checkout(customerId, vendorId, productId, 'ESEWA');
    const initiate = await request(t.app)
      .post('/api/payments/esewa/initiate')
      .set('authorization', bearer(customerId))
      .send({ order_id: order.id });
    const transactionUuid = bodyOf(esewaInitiateResponseSchema, initiate).fields.transaction_uuid;
    const paid = await request(t.app)
      .post('/api/payments/esewa/webhook')
      .send({
        data: esewaCallback({ transaction_uuid: transactionUuid ?? '', total_amount: '1050.0' }),
      });
    expect(bodyOf(paymentStatusResponseSchema, paid).payment).toMatchObject({
      order_state: 'PLACED',
      payment_status: 'PAID',
    });
    return { orderId: order.id, transactionUuid: transactionUuid ?? '' };
  }

  const decide = (
    userId: string,
    orderId: string,
    decision: 'accept' | 'reject',
    role: 'VENDOR' | 'CUSTOMER' | 'DRIVER' = 'VENDOR',
  ) =>
    request(t.app)
      .post(`/api/vendors/orders/${orderId}/${decision}`)
      .set('authorization', bearer(userId, role));

  const list = (userId: string, role: 'VENDOR' | 'CUSTOMER' = 'VENDOR') =>
    request(t.app).get('/api/vendors/orders').set('authorization', bearer(userId, role));

  const cancel = (customerId: string, orderId: string) =>
    request(t.app).post(`/api/orders/${orderId}/cancel`).set('authorization', bearer(customerId));

  async function rowOf(orderId: string) {
    const [row] = await db().select().from(orders).where(eq(orders.id, orderId));
    return row;
  }

  /** [from, to] of every order.state_changed row of the order, in commit order. */
  async function transitions(orderId: string) {
    return (await outboxFor(db(), orderId))
      .filter((row) => row.event_type === 'order.state_changed')
      .sort((a, b) => a.occurred_at.getTime() - b.occurred_at.getTime())
      .map((row) => {
        const payload = orderStateChangedPayloadSchema.parse(row.payload);
        return [payload.from_state, payload.to_state];
      });
  }

  async function refundEvents(orderId: string) {
    return (await outboxFor(db(), orderId)).filter(
      (row) => row.event_type === 'order.canceled_refund_due',
    );
  }

  describe('POST /api/vendors/orders/:id/accept', () => {
    it('moves a PLACED order to PREPARING and announces it in the same commit', async () => {
      const { customerId, vendorId, vendorUserId, productId } = await setup(10);
      const order = await checkout(customerId, vendorId, productId);

      const res = await decide(vendorUserId, order.id, 'accept');

      expect(res.status).toBe(200);
      expect(bodyOf(vendorOrderDecisionResponseSchema, res)).toEqual({
        order_id: order.id,
        state: 'PREPARING',
        refund_required: false,
      });
      expect(await rowOf(order.id)).toMatchObject({ state: 'PREPARING', refund_required: false });
      expect((await transitions(order.id)).at(-1)).toEqual(['PLACED', 'PREPARING']);
      // Accepting does not touch the stock: it was decremented at placement.
      expect(await stockOf(db(), productId)).toBe(8);
    });

    it('is idempotent: repeated and concurrent accepts change the state once', async () => {
      const { customerId, vendorId, vendorUserId, productId } = await setup();
      const order = await checkout(customerId, vendorId, productId);

      const concurrent = await Promise.all(
        Array.from({ length: 5 }, () => decide(vendorUserId, order.id, 'accept')),
      );
      const later = await decide(vendorUserId, order.id, 'accept');

      for (const res of [...concurrent, later]) {
        expect(res.status).toBe(200);
        expect(bodyOf(vendorOrderDecisionResponseSchema, res).state).toBe('PREPARING');
      }
      expect((await transitions(order.id)).filter(([, to]) => to === 'PREPARING')).toHaveLength(1);
    });

    it('refuses orders that are not waiting for the vendor (409 with the state)', async () => {
      const { customerId, vendorId, vendorUserId, productId } = await setup();
      const pending = await checkout(customerId, vendorId, productId, 'ESEWA');
      const canceled = await checkout(customerId, vendorId, productId);
      await cancel(customerId, canceled.id);
      const delivered = await checkout(customerId, vendorId, productId);
      await markDelivered(db(), delivered.id);

      for (const [order, state] of [
        [pending, 'PENDING_PAYMENT'],
        [canceled, 'CANCELED'],
        [delivered, 'DELIVERED'],
      ] as const) {
        const res = await decide(vendorUserId, order.id, 'accept');
        expect(res.status).toBe(409);
        expect(errorOf(res)).toMatchObject({ code: 'ORDER_STATE_CONFLICT', details: { state } });
        expect((await rowOf(order.id))?.state).toBe(state);
      }
    });

    it("does not shorten the customer's 60 s window: cancel still works inside it", async () => {
      const { customerId, vendorId, vendorUserId, productId } = await setup(10);
      const order = await checkout(customerId, vendorId, productId);
      await decide(vendorUserId, order.id, 'accept');
      await backdatePlacement(db(), order.id, 50);

      const res = await cancel(customerId, order.id);

      expect(res.status).toBe(200);
      expect(bodyOf(cancelOrderResponseSchema, res).state).toBe('CANCELED');
      expect(await stockOf(db(), productId)).toBe(10);
      expect((await transitions(order.id)).at(-1)).toEqual(['PREPARING', 'CANCELED']);
    });

    it('an accepted order still closes to the customer after 60 s', async () => {
      const { customerId, vendorId, vendorUserId, productId } = await setup(10);
      const order = await checkout(customerId, vendorId, productId);
      await decide(vendorUserId, order.id, 'accept');
      await backdatePlacement(db(), order.id, 61);

      const res = await cancel(customerId, order.id);

      expect(res.status).toBe(422);
      expect(errorOf(res).code).toBe('CANCELLATION_WINDOW_EXPIRED');
      expect((await rowOf(order.id))?.state).toBe('PREPARING');
      expect(await stockOf(db(), productId)).toBe(8);
    });
  });

  describe('POST /api/vendors/orders/:id/reject', () => {
    it('cancels a PLACED COD order and puts its stock back, without a refund', async () => {
      const { customerId, vendorId, vendorUserId, productId } = await setup(10);
      const order = await checkout(customerId, vendorId, productId);
      // A vendor may reject after the customer's window: that window is the customer's only.
      await backdatePlacement(db(), order.id, 120);

      const res = await decide(vendorUserId, order.id, 'reject');

      expect(res.status).toBe(200);
      expect(bodyOf(vendorOrderDecisionResponseSchema, res)).toEqual({
        order_id: order.id,
        state: 'CANCELED',
        refund_required: false,
      });
      expect(await rowOf(order.id)).toMatchObject({ state: 'CANCELED', refund_required: false });
      expect(await stockOf(db(), productId)).toBe(10);
      expect((await transitions(order.id)).at(-1)).toEqual(['PLACED', 'CANCELED']);
      expect(await refundEvents(order.id)).toEqual([]);
    });

    it('flags a PAID order for escrow refund and emits ORDER_CANCELED_REFUND_DUE in the same commit', async () => {
      const { customerId, vendorId, vendorUserId, productId } = await setup(10);
      const { orderId, transactionUuid } = await paidEsewaOrder(customerId, vendorId, productId);

      const res = await decide(vendorUserId, orderId, 'reject');

      expect(bodyOf(vendorOrderDecisionResponseSchema, res)).toEqual({
        order_id: orderId,
        state: 'CANCELED',
        refund_required: true,
      });
      expect(await rowOf(orderId)).toMatchObject({
        state: 'CANCELED',
        payment_status: 'PAID',
        refund_required: true,
      });
      expect(await stockOf(db(), productId)).toBe(10);
      const [event, ...others] = await refundEvents(orderId);
      expect(others).toEqual([]);
      expect(event?.topic).toBe('payment.reconciliation');
      expect(
        domainEventSchema.parse({
          event_id: event?.id,
          event_type: event?.event_type,
          event_version: 1,
          occurred_at: event?.occurred_at.toISOString(),
          aggregate_id: event?.aggregate_id,
          payload: event?.payload,
        }).payload,
      ).toEqual({
        order_id: orderId,
        vendor_id: vendorId,
        customer_id: customerId,
        payment_method: 'ESEWA',
        payment_gateway_ref: transactionUuid,
        refund_amount_npr: 1050,
        canceled_at: expect.any(String) as unknown,
      });
    });

    it('is idempotent: concurrent rejects restore stock and flag the refund once', async () => {
      const { customerId, vendorId, vendorUserId, productId } = await setup(10);
      const { orderId } = await paidEsewaOrder(customerId, vendorId, productId);

      const concurrent = await Promise.all(
        Array.from({ length: 5 }, () => decide(vendorUserId, orderId, 'reject')),
      );

      for (const res of concurrent) {
        expect(res.status).toBe(200);
        expect(bodyOf(vendorOrderDecisionResponseSchema, res).refund_required).toBe(true);
      }
      expect(await stockOf(db(), productId)).toBe(10);
      expect(await refundEvents(orderId)).toHaveLength(1);
    });

    it('answers the same success for an order the customer already canceled', async () => {
      const { customerId, vendorId, vendorUserId, productId } = await setup(10);
      const order = await checkout(customerId, vendorId, productId);
      await cancel(customerId, order.id);

      const res = await decide(vendorUserId, order.id, 'reject');

      expect(res.status).toBe(200);
      expect(bodyOf(vendorOrderDecisionResponseSchema, res).state).toBe('CANCELED');
      expect(await stockOf(db(), productId)).toBe(10); // restored once, by the cancel
    });

    it('cannot reject an order it has accepted', async () => {
      const { customerId, vendorId, vendorUserId, productId } = await setup();
      const order = await checkout(customerId, vendorId, productId);
      await decide(vendorUserId, order.id, 'accept');

      const res = await decide(vendorUserId, order.id, 'reject');

      expect(res.status).toBe(409);
      expect(errorOf(res)).toMatchObject({
        code: 'ORDER_STATE_CONFLICT',
        details: { state: 'PREPARING' },
      });
    });

    it('a simultaneous accept and reject: exactly one decision wins', async () => {
      const { customerId, vendorId, vendorUserId, productId } = await setup(10);
      const order = await checkout(customerId, vendorId, productId);

      const [accept, reject] = await Promise.all([
        decide(vendorUserId, order.id, 'accept'),
        decide(vendorUserId, order.id, 'reject'),
      ]);

      expect([accept.status, reject.status].sort()).toEqual([200, 409]);
      const state = (await rowOf(order.id))?.state;
      expect(state).toBe(accept.status === 200 ? 'PREPARING' : 'CANCELED');
      expect(await stockOf(db(), productId)).toBe(state === 'CANCELED' ? 10 : 8);
      expect(await transitions(order.id)).toHaveLength(3); // created, placed, one decision
    });
  });

  describe('ownership and authentication', () => {
    it("answers 404 for another vendor's order and for unknown ids, changing nothing", async () => {
      const { customerId, vendorId, productId } = await setup(10);
      const order = await checkout(customerId, vendorId, productId);
      const stranger = await vendorUserIdOf(db(), (await setup()).vendorId);

      for (const decision of ['accept', 'reject'] as const) {
        const theirs = await decide(stranger, order.id, decision);
        const unknown = await decide(stranger, randomUUID(), decision);
        for (const res of [theirs, unknown]) {
          expect(res.status).toBe(404);
          expect(errorOf(res).code).toBe('ORDER_NOT_FOUND');
        }
      }
      expect((await rowOf(order.id))?.state).toBe('PLACED');
      expect(await stockOf(db(), productId)).toBe(8);
    });

    it('requires a vendor token and a uuid', async () => {
      const { customerId, vendorId, vendorUserId, productId } = await setup();
      const order = await checkout(customerId, vendorId, productId);

      const anonymous = await request(t.app).post(`/api/vendors/orders/${order.id}/accept`);
      const asCustomer = await decide(customerId, order.id, 'accept', 'CUSTOMER');
      const asDriver = await decide(randomUUID(), order.id, 'reject', 'DRIVER');
      const malformed = await decide(vendorUserId, 'not-a-uuid', 'accept');

      expect(anonymous.status).toBe(401);
      expect(errorOf(asCustomer).code).toBe('FORBIDDEN');
      expect(asDriver.status).toBe(403);
      expect(malformed.status).toBe(400);
      expect(errorOf(malformed).code).toBe('VALIDATION_FAILED');
      expect((await rowOf(order.id))?.state).toBe('PLACED');
    });
  });

  describe('GET /api/vendors/orders', () => {
    it("lists only this vendor's open orders: new ones first, then those being packed", async () => {
      const { customerId, vendorId, vendorUserId, productId } = await setup(20);
      const accepted = await checkout(customerId, vendorId, productId);
      await decide(vendorUserId, accepted.id, 'accept');
      const first = await checkout(customerId, vendorId, productId);
      await backdatePlacement(db(), first.id, 30);
      const second = await checkout(customerId, vendorId, productId);
      await checkout(customerId, vendorId, productId, 'ESEWA'); // still paying: not the vendor's yet
      const canceled = await checkout(customerId, vendorId, productId);
      await cancel(customerId, canceled.id);
      const other = await setup();
      await checkout(other.customerId, other.vendorId, other.productId);

      const res = await list(vendorUserId);

      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
      const body = bodyOf(vendorOrderListResponseSchema, res);
      expect(body.orders.map((order) => [order.id, order.state])).toEqual([
        [first.id, 'PLACED'],
        [second.id, 'PLACED'],
        [accepted.id, 'PREPARING'],
      ]);
      expect(body.orders[0]).toMatchObject({
        payment_method: 'COD',
        total_npr: 1050,
        delivery_address: { ward_number: 26, tole_locality: 'Thamel' },
        items: [{ product_id: productId, quantity: 2, unit_price_npr: 500 }],
      });
    });

    it('never exposes the customer (the contract is strict)', async () => {
      const { customerId, vendorId, vendorUserId, productId } = await setup();
      await checkout(customerId, vendorId, productId);

      const res = await list(vendorUserId);

      const raw = JSON.stringify(res.body);
      expect(raw).not.toContain(customerId);
      expect(raw).not.toContain('delivery_otp');
      expect(bodyOf(vendorOrderListResponseSchema, res).orders).toHaveLength(1);
    });

    it('answers VENDOR_NOT_FOUND for a vendor account without a shop, 403 for customers', async () => {
      const shopless = await createUser(db(), 'VENDOR');
      const customer = await createUser(db());

      const missing = await list(shopless);
      const forbidden = await list(customer, 'CUSTOMER');

      expect(missing.status).toBe(404);
      expect(errorOf(missing).code).toBe('VENDOR_NOT_FOUND');
      expect(forbidden.status).toBe(403);
    });
  });
});
