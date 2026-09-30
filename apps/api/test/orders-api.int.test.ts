import { randomUUID } from 'node:crypto';

import { orderItems, orders } from '@hamro-pasal/db';
import {
  cancelOrderResponseSchema,
  checkoutResponseSchema,
  domainEventSchema,
  esewaInitiateResponseSchema,
  orderDetailResponseSchema,
  paymentStatusResponseSchema,
} from '@hamro-pasal/shared-types';
import { eq } from 'drizzle-orm';
import request from 'supertest';

import {
  backdateCheckout,
  backdatePlacement,
  createOrder,
  createProduct,
  createUser,
  createVendor,
  DELIVERY_ADDRESS,
  markDelivered,
  outboxFor,
  stockOf,
} from './support/fixtures';
import { bearer, bodyOf, buildTestApp, esewaCallback, errorOf, type TestApp } from './support/http';

/** GET /api/orders/:id and POST /api/orders/:id/cancel over real Express + PostgreSQL + Redis. */
describe('orders API', () => {
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
    const productId = await createProduct(db(), vendorId, stock, 500);
    return { customerId, vendorId, productId };
  }

  async function checkout(
    customerId: string,
    vendorId: string,
    productId: string,
    paymentMethod: 'COD' | 'ESEWA',
    extra: Record<string, unknown> = {},
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
        ...extra,
      });
    expect(res.status).toBe(201);
    return bodyOf(checkoutResponseSchema, res).order;
  }

  /** Checkout by eSewa and complete the payment: the order is PLACED and PAID. */
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

  const cancel = (customerId: string, orderId: string, role: 'CUSTOMER' | 'VENDOR' = 'CUSTOMER') =>
    request(t.app)
      .post(`/api/orders/${orderId}/cancel`)
      .set('authorization', bearer(customerId, role));

  const getOrder = (customerId: string, orderId: string) =>
    request(t.app).get(`/api/orders/${orderId}`).set('authorization', bearer(customerId));

  async function stateOf(orderId: string) {
    const [row] = await db().select().from(orders).where(eq(orders.id, orderId));
    return row;
  }

  async function refundEvents(orderId: string) {
    return (await outboxFor(db(), orderId)).filter(
      (e) => e.event_type === 'order.canceled_refund_due',
    );
  }

  describe('POST /api/orders/:id/cancel', () => {
    it('cancels a PLACED order at 59 seconds and puts its stock back', async () => {
      const { customerId, vendorId, productId } = await setup(10);
      const order = await checkout(customerId, vendorId, productId, 'COD');
      expect(order.state).toBe('PLACED');
      expect(await stockOf(db(), productId)).toBe(8);
      await backdatePlacement(db(), order.id, 59);

      const res = await cancel(customerId, order.id);

      expect(res.status).toBe(200);
      expect(bodyOf(cancelOrderResponseSchema, res)).toEqual({
        order_id: order.id,
        state: 'CANCELED',
        refund_required: false,
      });
      expect(await stateOf(order.id)).toMatchObject({ state: 'CANCELED', refund_required: false });
      expect(await stockOf(db(), productId)).toBe(10);
      expect(await refundEvents(order.id)).toEqual([]);
    });

    it('rejects cancellation at 61 seconds and leaves the order and stock untouched', async () => {
      const { customerId, vendorId, productId } = await setup(10);
      const order = await checkout(customerId, vendorId, productId, 'COD');
      await backdatePlacement(db(), order.id, 61);

      const res = await cancel(customerId, order.id);

      expect(res.status).toBe(422);
      expect(errorOf(res).code).toBe('CANCELLATION_WINDOW_EXPIRED');
      expect(await stateOf(order.id)).toMatchObject({ state: 'PLACED', refund_required: false });
      expect(await stockOf(db(), productId)).toBe(8);
    });

    it('flags a PAID order for refund and emits ORDER_CANCELED_REFUND_DUE in the same commit', async () => {
      const { customerId, vendorId, productId } = await setup(10);
      const { orderId, transactionUuid } = await paidEsewaOrder(customerId, vendorId, productId);
      await backdatePlacement(db(), orderId, 30);

      const res = await cancel(customerId, orderId);

      expect(bodyOf(cancelOrderResponseSchema, res)).toEqual({
        order_id: orderId,
        state: 'CANCELED',
        refund_required: true,
      });
      expect(await stateOf(orderId)).toMatchObject({
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
      ).toMatchObject({
        order_id: orderId,
        vendor_id: vendorId,
        customer_id: customerId,
        payment_method: 'ESEWA',
        payment_gateway_ref: transactionUuid,
        refund_amount_npr: 1050,
      });
    });

    it('is idempotent: repeated and concurrent cancels restore stock once', async () => {
      const { customerId, vendorId, productId } = await setup(10);
      const { orderId } = await paidEsewaOrder(customerId, vendorId, productId);

      const concurrent = await Promise.all(
        Array.from({ length: 5 }, () => cancel(customerId, orderId)),
      );
      const later = await cancel(customerId, orderId);

      for (const res of [...concurrent, later]) {
        expect(res.status).toBe(200);
        expect(bodyOf(cancelOrderResponseSchema, res).refund_required).toBe(true);
      }
      expect(await stockOf(db(), productId)).toBe(10);
      expect(await refundEvents(orderId)).toHaveLength(1);
    });

    it('measures the window from placement, not checkout, so paying time does not count', async () => {
      const { customerId, vendorId, productId } = await setup(10);
      const { orderId } = await paidEsewaOrder(customerId, vendorId, productId);
      // Checked out 5 minutes ago, but the payment (and so the placement) is fresh.
      await backdateCheckout(db(), orderId, 300);
      await backdatePlacement(db(), orderId, 50);

      const res = await cancel(customerId, orderId);

      expect(res.status).toBe(200);
      expect(bodyOf(cancelOrderResponseSchema, res).refund_required).toBe(true);
    });

    it('stamps placed_at when a COD order is placed at checkout and when a payment confirms', async () => {
      const { customerId, vendorId, productId } = await setup(10);
      const cod = await checkout(customerId, vendorId, productId, 'COD');
      const pending = await checkout(customerId, vendorId, productId, 'ESEWA');
      expect((await stateOf(pending.id))?.placed_at).toBeNull();
      const { orderId: paid } = await paidEsewaOrder(customerId, vendorId, productId);

      for (const id of [cod.id, paid]) {
        const row = await stateOf(id);
        expect(row?.state).toBe('PLACED');
        expect(row?.placed_at?.getTime()).toBeGreaterThanOrEqual(row?.created_at.getTime() ?? 0);
        expect(row?.placed_at?.getTime()).toBeGreaterThan(Date.now() - 60_000);
      }
    });

    it('treats a repeat cancel after the window as the same success', async () => {
      const { customerId, vendorId, productId } = await setup();
      const order = await checkout(customerId, vendorId, productId, 'COD');
      expect((await cancel(customerId, order.id)).status).toBe(200);
      await backdatePlacement(db(), order.id, 600);

      const res = await cancel(customerId, order.id);

      expect(res.status).toBe(200);
      expect(bodyOf(cancelOrderResponseSchema, res).state).toBe('CANCELED');
    });

    it('refuses orders that are not PLACED or PREPARING', async () => {
      const { customerId, vendorId, productId } = await setup();
      const pending = await checkout(customerId, vendorId, productId, 'ESEWA');
      const dispatched = await checkout(customerId, vendorId, productId, 'COD');
      await db()
        .update(orders)
        .set({ state: 'OUT_FOR_DELIVERY' })
        .where(eq(orders.id, dispatched.id));

      const pendingRes = await cancel(customerId, pending.id);
      const dispatchedRes = await cancel(customerId, dispatched.id);

      for (const res of [pendingRes, dispatchedRes]) {
        expect(res.status).toBe(409);
        expect(errorOf(res).code).toBe('ORDER_STATE_CONFLICT');
      }
      expect((await stateOf(pending.id))?.state).toBe('PENDING_PAYMENT');
      expect((await stateOf(dispatched.id))?.state).toBe('OUT_FOR_DELIVERY');
    });

    it("hides other customers' orders and requires a customer token", async () => {
      const { customerId, vendorId, productId } = await setup();
      const order = await checkout(customerId, vendorId, productId, 'COD');
      const stranger = await createUser(db());

      const foreign = await cancel(stranger, order.id);
      const unknown = await cancel(customerId, randomUUID());
      const asVendor = await cancel(customerId, order.id, 'VENDOR');
      const malformed = await cancel(customerId, 'order-1');

      expect([foreign.status, unknown.status, asVendor.status, malformed.status]).toEqual([
        404, 404, 403, 400,
      ]);
      expect(errorOf(foreign).code).toBe('ORDER_NOT_FOUND');
      expect((await stateOf(order.id))?.state).toBe('PLACED');
    });
  });

  describe('GET /api/orders/:id', () => {
    it('returns the full snapshot with items, delivery address and delivered_at', async () => {
      const { customerId, vendorId, productId } = await setup();
      const order = await checkout(customerId, vendorId, productId, 'COD', {
        delivery_address: { ...DELIVERY_ADDRESS, district_string: 'kathmandu' },
      });

      const placed = bodyOf(orderDetailResponseSchema, await getOrder(customerId, order.id)).order;
      await markDelivered(db(), order.id);
      const delivered = bodyOf(
        orderDetailResponseSchema,
        await getOrder(customerId, order.id),
      ).order;

      expect(placed).toMatchObject({
        id: order.id,
        customer_id: customerId,
        vendor_id: vendorId,
        state: 'PLACED',
        payment_method: 'COD',
        subtotal_npr: 1000,
        delivery_fee_npr: 50,
        total_npr: 1050,
        refund_required: false,
        delivered_at: null,
        delivery_address: DELIVERY_ADDRESS,
        items: [{ product_id: productId, unit_price_npr: 500, quantity: 2 }],
      });
      expect(Date.parse(placed.placed_at ?? '')).toBeGreaterThan(Date.now() - 60_000);
      expect(delivered.state).toBe('DELIVERED');
      expect(delivered.placed_at).toBe(placed.placed_at);
      expect(Date.parse(delivered.delivered_at ?? '')).toBeGreaterThan(Date.now() - 60_000);
    });

    it('returns a null address for orders created before checkout required one', async () => {
      const { customerId, vendorId, productId } = await setup();
      const order = await createOrder(db(), { customerId, vendorId });
      await db().insert(orderItems).values({
        order_id: order.id,
        product_id: productId,
        product_name: 'Legacy item',
        unit_price_npr: 500,
        quantity: 2,
      });

      const body = bodyOf(orderDetailResponseSchema, await getOrder(customerId, order.id));

      expect(body.order.delivery_address).toBeNull();
    });

    it("hides other customers' orders", async () => {
      const { customerId, vendorId, productId } = await setup();
      const order = await checkout(customerId, vendorId, productId, 'COD');

      const res = await getOrder(await createUser(db()), order.id);

      expect(res.status).toBe(404);
      expect(errorOf(res).code).toBe('ORDER_NOT_FOUND');
    });
  });
});
