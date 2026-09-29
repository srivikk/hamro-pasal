import { randomUUID } from 'node:crypto';

import { orderItems, orders, reviews } from '@hamro-pasal/db';
import { compare } from 'bcryptjs';
import { checkoutResponseSchema, lockStatusResponseSchema } from '@hamro-pasal/shared-types';
import { eq } from 'drizzle-orm';
import request from 'supertest';

import {
  createOrder,
  createProduct,
  createUser,
  createVendor,
  markDelivered,
  outboxFor,
  stockOf,
} from './support/fixtures';
import { bearer, bodyOf, buildTestApp, errorOf, type TestApp } from './support/http';

/** POST /api/cart/checkout and GET /api/cart/lock-status over real Express + PostgreSQL + Redis. */
describe('cart API', () => {
  let t: TestApp;

  beforeAll(() => {
    t = buildTestApp();
  });

  afterAll(async () => {
    await t.container.close();
  });

  const db = () => t.container.db;

  async function setup(options: { stock?: number; minOrderValue?: number } = {}) {
    const customerId = await createUser(db());
    const vendorId = await createVendor(db(), {
      commissionRate: 0.1,
      minOrderValue: options.minOrderValue ?? 0,
      baseDeliveryFee: 50,
    });
    const productId = await createProduct(db(), vendorId, options.stock ?? 10, 250);
    return { customerId, vendorId, productId };
  }

  const checkout = (customerId: string, body: Record<string, unknown>, app = t.app) =>
    request(app).post('/api/cart/checkout').set('authorization', bearer(customerId)).send(body);

  const lockStatus = (customerId: string, orderId: string, app = t.app) =>
    request(app)
      .get('/api/cart/lock-status')
      .query({ order_id: orderId })
      .set('authorization', bearer(customerId));

  const cart = (vendorId: string, productId: string, paymentMethod: string, quantity = 1) => ({
    idempotency_key: randomUUID(),
    vendor_id: vendorId,
    payment_method: paymentMethod,
    items: [{ product_id: productId, quantity }],
  });

  describe('POST /api/cart/checkout', () => {
    it('requires a customer bearer token', async () => {
      const anonymous = await request(t.app).post('/api/cart/checkout').send({});
      const vendorToken = await request(t.app)
        .post('/api/cart/checkout')
        .set('authorization', bearer(randomUUID(), 'VENDOR'))
        .send({});
      const unsigned = await request(t.app)
        .post('/api/cart/checkout')
        .set('authorization', 'Bearer eyJhbGciOiJub25lIn0.e30.')
        .send({});

      expect([anonymous.status, vendorToken.status, unsigned.status]).toEqual([401, 403, 401]);
    });

    it('validates the body against the shared schema', async () => {
      const { customerId } = await setup();

      const res = await checkout(customerId, { vendor_id: 'nope', items: [] });

      expect(res.status).toBe(400);
      const error = errorOf(res);
      expect(error.code).toBe('VALIDATION_FAILED');
      const { issues } = error.details as { issues: { path: string }[] };
      expect(issues.map((i) => i.path)).toEqual(
        expect.arrayContaining(['idempotency_key', 'vendor_id', 'payment_method', 'items']),
      );
    });

    it('locks the cart and creates a server-priced PENDING_PAYMENT order for prepaid checkout', async () => {
      const { customerId, vendorId, productId } = await setup();

      const res = await checkout(customerId, cart(vendorId, productId, 'ESEWA', 3));

      expect(res.status).toBe(201);
      const body = bodyOf(checkoutResponseSchema, res);
      expect(body.order).toMatchObject({
        state: 'PENDING_PAYMENT',
        payment_method: 'ESEWA',
        payment_status: 'PENDING',
        fulfillment: 'SELF_DELIVERY',
        subtotal_npr: 750,
        delivery_fee_npr: 50,
        total_npr: 800,
      });
      const expiresIn = Date.parse(body.reservation.expires_at ?? '') - Date.now();
      expect(expiresIn).toBeGreaterThan(590_000);
      expect(expiresIn).toBeLessThanOrEqual(600_000);

      const [order] = await db().select().from(orders).where(eq(orders.id, body.order.id));
      expect(order).toMatchObject({
        platform_commission_amount: 75,
        reservation_id: body.reservation.id,
      });
      expect(body.delivery_otp).toMatch(/^\d{4}$/);
      expect(await compare(body.delivery_otp ?? '', order?.delivery_otp ?? '')).toBe(true);
      expect(
        await db().select().from(orderItems).where(eq(orderItems.order_id, body.order.id)),
      ).toEqual([
        expect.objectContaining({ product_id: productId, quantity: 3, unit_price_npr: 250 }),
      ]);
      expect(body.reservation.id).not.toBeNull();
      expect((await outboxFor(db(), body.reservation.id ?? ''))[0]?.event_type).toBe(
        'order.locked',
      );
      expect(await stockOf(db(), productId)).toBe(10); // held in Redis, not yet decremented
    });

    it('places COD orders immediately: stock decremented, lock released', async () => {
      const { customerId, vendorId, productId } = await setup();

      const res = await checkout(customerId, cart(vendorId, productId, 'COD', 2));

      expect(res.status).toBe(201);
      const body = bodyOf(checkoutResponseSchema, res);
      expect(body.order.state).toBe('PLACED');
      expect(await stockOf(db(), productId)).toBe(8);
      const status = bodyOf(lockStatusResponseSchema, await lockStatus(customerId, body.order.id));
      expect(status.lock).toEqual({ status: 'RELEASED', ttl_ms: 0, expires_at: null });
    });

    it('returns the same order when an idempotency key is replayed, rotating the OTP', async () => {
      const { customerId, vendorId, productId } = await setup();
      const request = cart(vendorId, productId, 'KHALTI');

      const first = bodyOf(checkoutResponseSchema, await checkout(customerId, request));
      const replayRes = await checkout(customerId, request);
      const replay = bodyOf(checkoutResponseSchema, replayRes);
      const [order] = await db().select().from(orders).where(eq(orders.id, first.order.id));

      expect(replayRes.status).toBe(200);
      expect(replay).toMatchObject({ replayed: true, order: { id: first.order.id } });
      expect(await compare(replay.delivery_otp ?? '', order?.delivery_otp ?? '')).toBe(true);
      const hijack = await checkout(await createUser(db()), request);
      expect(hijack.status).toBe(409);
      expect(errorOf(hijack).code).toBe('IDEMPOTENCY_KEY_REUSED');
    });

    it('creates exactly one order and one lock under concurrent duplicate submissions', async () => {
      const { customerId, vendorId, productId } = await setup({ stock: 5 });
      const request = cart(vendorId, productId, 'ESEWA', 5);

      const responses = await Promise.all(
        Array.from({ length: 5 }, () => checkout(customerId, request)),
      );

      const ids = responses.map((r) => bodyOf(checkoutResponseSchema, r).order.id);
      expect(new Set(ids).size).toBe(1);
      expect(responses.filter((r) => r.status === 201)).toHaveLength(1);
      // Only one lock exists: the 5 units are held once, not five times.
      const other = await checkout(customerId, cart(vendorId, productId, 'ESEWA', 1));
      expect(other.status).toBe(409);
      expect(errorOf(other).code).toBe('INSUFFICIENT_STOCK');
    });

    it('rejects carts below the vendor minimum order value', async () => {
      const { customerId, vendorId, productId } = await setup({ minOrderValue: 500 });

      const res = await checkout(customerId, cart(vendorId, productId, 'ESEWA', 1));

      expect(res.status).toBe(422);
      expect(errorOf(res)).toMatchObject({
        code: 'BELOW_MINIMUM_ORDER_VALUE',
        details: { minimum_npr: 500, subtotal_npr: 250 },
      });
    });

    it('rejects products of another vendor and out-of-stock quantities', async () => {
      const { customerId, vendorId, productId } = await setup({ stock: 1 });
      const foreign = await createProduct(db(), await createVendor(db()), 10);

      const wrongVendor = await checkout(customerId, cart(vendorId, foreign, 'COD'));
      const tooMany = await checkout(customerId, cart(vendorId, productId, 'COD', 2));

      expect(wrongVendor.status).toBe(422);
      expect(errorOf(wrongVendor).code).toBe('PRODUCT_UNAVAILABLE');
      expect(tooMany.status).toBe(409);
      expect(errorOf(tooMany).details).toEqual({
        shortfalls: [{ productId, requested: 2, available: 1 }],
      });
    });

    it('refuses COD to customers rated below 3.0 but still allows prepaid', async () => {
      const { customerId, vendorId, productId } = await setup();
      for (const rating of [2, 3]) {
        const past = await createOrder(db(), { vendorId, customerId });
        await markDelivered(db(), past.id);
        await db().insert(reviews).values({
          order_id: past.id,
          direction: 'VENDOR_TO_CUSTOMER',
          rating,
          is_published: true,
          published_at: new Date(),
        });
      }

      const cod = await checkout(customerId, cart(vendorId, productId, 'COD'));
      const prepaid = await checkout(customerId, cart(vendorId, productId, 'KHALTI'));

      expect(cod.status).toBe(422);
      expect(errorOf(cod).code).toBe('COD_NOT_AVAILABLE');
      expect(prepaid.status).toBe(201);
    });
  });

  describe('GET /api/cart/lock-status', () => {
    it('reports the remaining TTL of an active lock', async () => {
      const { customerId, vendorId, productId } = await setup();
      const created = bodyOf(
        checkoutResponseSchema,
        await checkout(customerId, cart(vendorId, productId, 'ESEWA')),
      );

      const res = await lockStatus(customerId, created.order.id);

      expect(res.status).toBe(200);
      const { lock } = bodyOf(lockStatusResponseSchema, res);
      expect(lock.status).toBe('ACTIVE');
      expect(lock.ttl_ms).toBeGreaterThan(590_000);
    });

    it('reports EXPIRED once the TTL hits 0 so the client purges the cart', async () => {
      const short = buildTestApp({ lockTtlMs: 300 });
      try {
        const { customerId, vendorId, productId } = await setup();
        const created = bodyOf(
          checkoutResponseSchema,
          await checkout(customerId, cart(vendorId, productId, 'ESEWA'), short.app),
        );
        await new Promise((resolve) => setTimeout(resolve, 600));

        const res = await lockStatus(customerId, created.order.id, short.app);

        expect(bodyOf(lockStatusResponseSchema, res).lock).toEqual({
          status: 'EXPIRED',
          ttl_ms: 0,
          expires_at: null,
        });
      } finally {
        await short.container.close();
      }
    });

    it('hides other customers’ orders and validates the query', async () => {
      const { customerId, vendorId, productId } = await setup();
      const created = bodyOf(
        checkoutResponseSchema,
        await checkout(customerId, cart(vendorId, productId, 'ESEWA')),
      );

      const stranger = await lockStatus(await createUser(db()), created.order.id);
      const invalid = await lockStatus(customerId, 'x');

      expect(stranger.status).toBe(404);
      expect(invalid.status).toBe(400);
    });
  });
});
