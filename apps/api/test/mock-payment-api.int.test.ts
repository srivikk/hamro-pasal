import { randomUUID } from 'node:crypto';

import { orders } from '@hamro-pasal/db';
import { checkoutResponseSchema, paymentStatusResponseSchema } from '@hamro-pasal/shared-types';
import { eq } from 'drizzle-orm';
import request from 'supertest';

import { createApp } from '../src/app';
import {
  balanceOf,
  createProduct,
  createUser,
  createVendor,
  DELIVERY_ADDRESS,
  outboxFor,
  stockOf,
} from './support/fixtures';
import { bearer, bodyOf, buildTestApp, errorOf, type TestApp } from './support/http';

/** POST /api/test/mock-payment over real Express + PostgreSQL + Redis. No gateway is contacted. */
describe('mock payment API (MOCK_SERVICES)', () => {
  let t: TestApp;

  beforeAll(() => {
    // Khalti's HTTP client would throw if anything reached it: no fake is installed.
    t = buildTestApp({ mockServices: true });
  });

  afterAll(async () => {
    await t.container.close();
  });

  const db = () => t.container.db;
  const escrow = async () => (await balanceOf(db(), 'SYSTEM_ESCROW')) ?? 0;

  /** An order of 2 x 500 NPR + 50 NPR delivery = 1050 NPR; prepaid ones hold a live 600 s lock. */
  async function checkout(paymentMethod: 'ESEWA' | 'KHALTI' | 'COD', app: TestApp = t) {
    const customerId = await createUser(db());
    const vendorId = await createVendor(db(), { baseDeliveryFee: 50 });
    const productId = await createProduct(db(), vendorId, 5, 500);
    const res = await request(app.app)
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
    return { customerId, productId, orderId: bodyOf(checkoutResponseSchema, res).order.id };
  }

  async function orderRow(orderId: string) {
    const [order] = await db().select().from(orders).where(eq(orders.id, orderId));
    if (order === undefined) throw new Error('order vanished');
    return order;
  }

  const pay = (orderId: unknown, app: TestApp = t) =>
    request(app.app).post('/api/test/mock-payment').send({ order_id: orderId });

  it('pays an eSewa order that never reached the gateway: PAID, PLACED, escrow credited', async () => {
    const { orderId, productId } = await checkout('ESEWA');
    const before = await escrow();
    expect((await orderRow(orderId)).payment_gateway_ref).toBeNull();

    const res = await pay(orderId);

    expect(res.status).toBe(200);
    expect(bodyOf(paymentStatusResponseSchema, res)).toEqual({
      status: 'COMPLETE',
      payment: {
        order_id: orderId,
        order_state: 'PLACED',
        payment_status: 'PAID',
        duplicate: false,
      },
    });
    const order = await orderRow(orderId);
    expect(order.state).toBe('PLACED');
    expect(order.payment_status).toBe('PAID');
    expect(order.placed_at).not.toBeNull();
    expect(order.payment_gateway_ref).not.toBeNull();
    expect(await escrow()).toBe(before + 1050);
    expect(await stockOf(db(), productId)).toBe(3);
    const events = (await outboxFor(db(), orderId)).map((event) => event.event_type);
    expect(events).toContain('order.placed');
    expect(events.filter((type) => type === 'order.state_changed')).toHaveLength(2);
  });

  it('pays an eSewa order whose payment the app already started, on the stored reference', async () => {
    const { orderId, customerId } = await checkout('ESEWA');
    const initiated = await request(t.app)
      .post('/api/payments/esewa/initiate')
      .set('authorization', bearer(customerId))
      .send({ order_id: orderId });
    expect(initiated.status).toBe(200);
    const reference = (await orderRow(orderId)).payment_gateway_ref;

    const res = await pay(orderId);

    expect(res.status).toBe(200);
    const order = await orderRow(orderId);
    expect(order.payment_gateway_ref).toBe(reference);
    expect(order.state).toBe('PLACED');
  });

  it('pays a Khalti order without a lookup at Khalti', async () => {
    const { orderId } = await checkout('KHALTI');
    const before = await escrow();

    const res = await pay(orderId);

    expect(res.status).toBe(200);
    expect(bodyOf(paymentStatusResponseSchema, res)).toEqual({
      status: 'Completed',
      payment: {
        order_id: orderId,
        order_state: 'PLACED',
        payment_status: 'PAID',
        duplicate: false,
      },
    });
    expect((await orderRow(orderId)).payment_gateway_ref).toMatch(/^mock-pidx-/);
    expect(await escrow()).toBe(before + 1050);
  });

  it('credits escrow once when the same order is paid again', async () => {
    const { orderId, productId } = await checkout('ESEWA');
    const before = await escrow();

    expect((await pay(orderId)).status).toBe(200);
    const again = await pay(orderId);

    expect(again.status).toBe(200);
    expect(bodyOf(paymentStatusResponseSchema, again).payment).toEqual({
      order_id: orderId,
      order_state: 'PLACED',
      payment_status: 'PAID',
      duplicate: true,
    });
    expect(await escrow()).toBe(before + 1050);
    expect(await stockOf(db(), productId)).toBe(3);
  });

  it('credits escrow once for five simultaneous calls', async () => {
    const { orderId } = await checkout('KHALTI');
    const before = await escrow();

    const answers = await Promise.all(Array.from({ length: 5 }, () => pay(orderId)));

    expect(answers.map((res) => res.status)).toEqual([200, 200, 200, 200, 200]);
    const fresh = answers.filter(
      (res) => bodyOf(paymentStatusResponseSchema, res).payment?.duplicate === false,
    );
    expect(fresh).toHaveLength(1);
    expect(await escrow()).toBe(before + 1050);
    expect((await orderRow(orderId)).state).toBe('PLACED');
  });

  it('behaves like a late gateway callback once the 600 s lock is gone', async () => {
    const short = buildTestApp({ mockServices: true, lockTtlMs: 1_500 });
    try {
      const { orderId } = await checkout('ESEWA', short);
      await new Promise((resolve) => setTimeout(resolve, 1_800));

      const res = await pay(orderId, short);

      expect(res.status).toBe(409);
      expect(errorOf(res).code).toBe('PAID_AFTER_SESSION_EXPIRED');
      const order = await orderRow(orderId);
      expect(order.state).toBe('FAILED');
      expect(order.payment_status).toBe('PAID');
    } finally {
      await short.container.close();
    }
  });

  it('refuses a COD order and leaves it untouched', async () => {
    const { orderId } = await checkout('COD');
    const before = await orderRow(orderId);

    const res = await pay(orderId);

    expect(res.status).toBe(409);
    expect(errorOf(res).code).toBe('WRONG_PAYMENT_METHOD');
    expect(await orderRow(orderId)).toEqual(before);
  });

  it('answers 404 for an unknown order and 400 for a malformed body', async () => {
    const unknown = await pay(randomUUID());
    expect(unknown.status).toBe(404);
    expect(errorOf(unknown).code).toBe('ORDER_NOT_FOUND');

    for (const body of [{}, { order_id: 'not-a-uuid' }, { order_id: 42 }]) {
      const res = await request(t.app).post('/api/test/mock-payment').send(body);
      expect(res.status).toBe(400);
      expect(errorOf(res).code).toBe('VALIDATION_FAILED');
    }
  });

  describe('the guard', () => {
    const realNodeEnv = process.env.NODE_ENV;

    afterEach(() => {
      process.env.NODE_ENV = realNodeEnv;
    });

    it('is not served without MOCK_SERVICES', async () => {
      const plain = buildTestApp();
      try {
        const { orderId } = await checkout('ESEWA', plain);

        const res = await pay(orderId, plain);

        expect(plain.container.mockPayments).toBeUndefined();
        expect(res.status).toBe(404);
        expect(errorOf(res).code).toBe('NOT_FOUND');
        expect((await orderRow(orderId)).payment_status).toBe('PENDING');
      } finally {
        await plain.container.close();
      }
    });

    it('is a 404 in production even when MOCK_SERVICES is asked for', async () => {
      const { orderId } = await checkout('ESEWA');
      process.env.NODE_ENV = 'production';
      const production = buildTestApp({ mockServices: true });
      try {
        const res = await pay(orderId, production);

        expect(production.container.mockPayments).toBeUndefined();
        expect(res.status).toBe(404);
        expect(errorOf(res).code).toBe('NOT_FOUND');
        expect((await orderRow(orderId)).payment_status).toBe('PENDING');
      } finally {
        await production.container.close();
      }
    });

    it('is a 404 in a production process even if a container still carried the service', async () => {
      const { orderId } = await checkout('ESEWA');
      process.env.NODE_ENV = 'production';

      const res = await request(createApp(t.container))
        .post('/api/test/mock-payment')
        .send({ order_id: orderId });

      expect(t.container.mockPayments).toBeDefined();
      expect(res.status).toBe(404);
      expect((await orderRow(orderId)).payment_status).toBe('PENDING');
    });
  });
});
