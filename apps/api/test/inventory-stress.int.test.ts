import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';

import { orderItems, orders } from '@hamro-pasal/db';
import { checkoutResponseSchema } from '@hamro-pasal/shared-types';
import { eq } from 'drizzle-orm';
import request from 'supertest';

import { inventoryKeys } from '../src/inventory/inventory-lock-service';
import {
  createProduct,
  createUser,
  createVendor,
  DELIVERY_ADDRESS,
  stockOf,
} from './support/fixtures';
import { bearer, bodyOf, buildTestApp, errorOf, type TestApp } from './support/http';

/**
 * 100 concurrent checkouts take 10 to 15 s on a developer machine: more than the 10 s per-test cap
 * the safe test runs pass on the command line (--testTimeout=10000), which would cut them off.
 */
const STRESS_TIMEOUT_MS = 60_000;

/**
 * Phase 23: the whole checkout path under contention, over real Express + PostgreSQL + Redis.
 * 100 customers check out the same product at the same moment through POST /api/cart/checkout
 * (the stock guard, the Redis 600 s lock and the guarded decrement of the claim, SPEC §3). COD is
 * used because it is claimed in the same request, so the PostgreSQL stock moves at once.
 */
describe('checkout under contention (100 concurrent requests)', () => {
  let t: TestApp;
  let server: Server;

  beforeAll(async () => {
    t = buildTestApp();
    server = await new Promise<Server>((resolve) => {
      const listening = t.app.listen(0, () => {
        resolve(listening);
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error === undefined) resolve();
        else reject(error);
      });
    });
    await t.container.close();
  });

  const db = () => t.container.db;

  function checkout(customerId: string, vendorId: string, productId: string, quantity: number) {
    return request(server)
      .post('/api/cart/checkout')
      .set('authorization', bearer(customerId))
      .send({
        idempotency_key: randomUUID(),
        vendor_id: vendorId,
        payment_method: 'COD',
        items: [{ product_id: productId, quantity }],
        delivery_address: DELIVERY_ADDRESS,
      });
  }

  /** The placed orders holding this product, with the quantity each one bought. */
  function soldLines(productId: string) {
    return db()
      .select({ state: orders.state, quantity: orderItems.quantity })
      .from(orderItems)
      .innerJoin(orders, eq(orders.id, orderItems.order_id))
      .where(eq(orderItems.product_id, productId));
  }

  const liveHolds = (vendorId: string, productId: string) =>
    t.container.redisPool.withConnection((redis) =>
      redis.hgetall(inventoryKeys.holds(vendorId, productId)),
    );

  it(
    'sells exactly the 5 units in stock: 5 orders, 95 × 409 INSUFFICIENT_STOCK, stock 0',
    async () => {
      const vendorId = await createVendor(db());
      const productId = await createProduct(db(), vendorId, 5, 100);
      const customers = await Promise.all(Array.from({ length: 100 }, () => createUser(db())));

      const responses = await Promise.all(
        customers.map((customerId) => checkout(customerId, vendorId, productId, 1)),
      );

      const placed = responses.filter((res) => res.status === 201);
      const refused = responses.filter((res) => res.status !== 201);
      expect(placed).toHaveLength(5);
      expect(refused).toHaveLength(95);
      expect(refused.map((res) => res.status)).toEqual(Array.from({ length: 95 }, () => 409));
      expect(new Set(refused.map((res) => errorOf(res).code))).toEqual(
        new Set(['INSUFFICIENT_STOCK']),
      );
      for (const res of placed) {
        expect(bodyOf(checkoutResponseSchema, res).order.state).toBe('PLACED');
      }

      expect(await stockOf(db(), productId)).toBe(0);
      const lines = await soldLines(productId);
      expect(lines).toHaveLength(5);
      expect(lines.every((line) => line.state === 'PLACED' && line.quantity === 1)).toBe(true);
      // Every refused request gave its hold back, and every claim released its own.
      expect(await liveHolds(vendorId, productId)).toEqual({});
    },
    STRESS_TIMEOUT_MS,
  );

  it(
    'never oversells or goes negative when the requests ask for different quantities',
    async () => {
      const vendorId = await createVendor(db());
      const productId = await createProduct(db(), vendorId, 25, 100);
      const customers = await Promise.all(Array.from({ length: 100 }, () => createUser(db())));

      const responses = await Promise.all(
        customers.map((customerId, n) => checkout(customerId, vendorId, productId, (n % 4) + 1)),
      );

      const statuses = new Set(responses.map((res) => res.status));
      expect([...statuses].every((status) => status === 201 || status === 409)).toBe(true);
      const sold = (await soldLines(productId)).reduce((total, line) => total + line.quantity, 0);
      const stock = await stockOf(db(), productId);
      expect(stock).toBeGreaterThanOrEqual(0);
      expect(sold + stock).toBe(25);
      // Each unit costs 100 NPR, so the subtotals the customers were shown add up to the units sold.
      const promised = responses
        .filter((res) => res.status === 201)
        .reduce((total, res) => total + bodyOf(checkoutResponseSchema, res).order.subtotal_npr, 0);
      expect(promised).toBe(sold * 100);
      expect(await liveHolds(vendorId, productId)).toEqual({});
    },
    STRESS_TIMEOUT_MS,
  );
});
