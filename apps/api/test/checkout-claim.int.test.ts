import { orders, products, type Database } from '@hamro-pasal/db';
import { orderLockedPayloadSchema, orderPlacedPayloadSchema } from '@hamro-pasal/shared-types';
import { eq } from 'drizzle-orm';

import { CheckoutService, OrderNotPlaceableError } from '../src/checkout/checkout-service';
import { RedisKeyedMutex } from '../src/infra/redis-mutex';
import type { RedisConnectionPool } from '../src/infra/redis-pool';
import { InsufficientStockError, ReservationExpiredError } from '../src/inventory/errors';
import { InventoryLockService } from '../src/inventory/inventory-lock-service';
import { DrizzleStockReader } from '../src/inventory/stock-reader';
import { LedgerService } from '../src/ledger/ledger-service';
import { SettlementService } from '../src/ledger/settlement-service';
import {
  createOrder,
  createProduct,
  createUser,
  createVendor,
  outboxFor,
  stockOf,
  testDatabase,
  testRedisPool,
} from './support/fixtures';

/** SPEC §3 resolution: confirm within 600 s -> permanent decrement + lock deleted. */
describe('checkout lock / claim / release workflows', () => {
  let db: Database;
  let pool: RedisConnectionPool;
  let locks: InventoryLockService;
  let checkout: CheckoutService;
  let vendorId: string;
  let customerId: string;

  beforeAll(async () => {
    db = testDatabase();
    pool = testRedisPool(10);
    locks = new InventoryLockService(pool, new DrizzleStockReader(db));
    checkout = new CheckoutService(db, locks, new RedisKeyedMutex(pool));
    vendorId = await createVendor(db);
    customerId = await createUser(db);
  });

  afterAll(async () => {
    await pool.close();
    await db.$client.end();
  });

  async function orderState(orderId: string) {
    const [order] = await db.select().from(orders).where(eq(orders.id, orderId));
    return order?.state;
  }

  it('records order.locked in the outbox when a cart is locked', async () => {
    const productId = await createProduct(db, vendorId, 5);

    const reservation = await checkout.lockCart({
      vendorId,
      customerId,
      items: [{ productId, quantity: 2 }],
    });

    const [event] = await outboxFor(db, reservation.id);
    expect(event?.event_type).toBe('order.locked');
    expect(event?.topic).toBe('order.lifecycle');
    expect(orderLockedPayloadSchema.parse(event?.payload)).toMatchObject({
      reservation_id: reservation.id,
      items: [{ product_id: productId, quantity: 2 }],
    });
  });

  it('claims a COD order: decrements stock, marks PLACED, emits order.placed, frees the lock', async () => {
    const productId = await createProduct(db, vendorId, 5);
    const reservation = await checkout.lockCart({
      vendorId,
      customerId,
      items: [{ productId, quantity: 3 }],
    });
    const order = await createOrder(db, { vendorId, customerId });

    const placed = await checkout.claim({
      orderId: order.id,
      vendorId,
      reservationId: reservation.id,
    });

    expect(placed.order.state).toBe('PLACED');
    expect(await stockOf(db, productId)).toBe(2);
    expect(await checkout.getLockStatus(vendorId, reservation.id)).toBeNull();
    const events = await outboxFor(db, order.id);
    expect(events.map((e) => e.event_type).sort()).toEqual(['order.placed', 'order.state_changed']);
    const event = events.find((e) => e.event_type === 'order.placed');
    expect(orderPlacedPayloadSchema.parse(event?.payload).items).toEqual([
      { product_id: productId, quantity: 3 },
    ]);
    // The 2 remaining units are immediately lockable: no double counting of hold + decrement.
    await expect(
      checkout.lockCart({ vendorId, customerId, items: [{ productId, quantity: 2 }] }),
    ).resolves.toBeDefined();
  });

  it('refuses to claim after the lock expired ("Session Expired")', async () => {
    const productId = await createProduct(db, vendorId, 5);
    const shortLocks = new InventoryLockService(pool, new DrizzleStockReader(db), { ttlMs: 200 });
    const reservation = await new CheckoutService(
      db,
      shortLocks,
      new RedisKeyedMutex(pool),
    ).lockCart({
      vendorId,
      customerId,
      items: [{ productId, quantity: 1 }],
    });
    const order = await createOrder(db, { vendorId, customerId });
    await new Promise((resolve) => setTimeout(resolve, 400));

    await expect(
      checkout.claim({ orderId: order.id, vendorId, reservationId: reservation.id }),
    ).rejects.toBeInstanceOf(ReservationExpiredError);
    expect(await stockOf(db, productId)).toBe(5);
    expect(await orderState(order.id)).toBe('PENDING_PAYMENT');
  });

  it('refuses to place a prepaid order before its payment is captured', async () => {
    const productId = await createProduct(db, vendorId, 5);
    const reservation = await checkout.lockCart({
      vendorId,
      customerId,
      items: [{ productId, quantity: 1 }],
    });
    const order = await createOrder(db, { vendorId, customerId, paymentMethod: 'ESEWA' });

    await expect(
      checkout.claim({ orderId: order.id, vendorId, reservationId: reservation.id }),
    ).rejects.toBeInstanceOf(OrderNotPlaceableError);

    await new SettlementService(db, new LedgerService()).capturePayment(order.id);
    const placed = await checkout.claim({
      orderId: order.id,
      vendorId,
      reservationId: reservation.id,
    });
    expect(placed.order.state).toBe('PLACED');
  });

  it('rolls back everything if PostgreSQL stock no longer covers the lock', async () => {
    const productId = await createProduct(db, vendorId, 5);
    const reservation = await checkout.lockCart({
      vendorId,
      customerId,
      items: [{ productId, quantity: 4 }],
    });
    const order = await createOrder(db, { vendorId, customerId });
    // e.g. the vendor corrects stock for spoiled goods while the customer is paying
    await db.update(products).set({ stock_quantity: 3 }).where(eq(products.id, productId));

    await expect(
      checkout.claim({ orderId: order.id, vendorId, reservationId: reservation.id }),
    ).rejects.toBeInstanceOf(InsufficientStockError);

    expect(await stockOf(db, productId)).toBe(3);
    expect(await orderState(order.id)).toBe('PENDING_PAYMENT');
    expect(await outboxFor(db, order.id)).toEqual([]);
  });

  it('places an order exactly once under concurrent duplicate claims (e.g. webhook retries)', async () => {
    const productId = await createProduct(db, vendorId, 5);
    const reservation = await checkout.lockCart({
      vendorId,
      customerId,
      items: [{ productId, quantity: 2 }],
    });
    const order = await createOrder(db, { vendorId, customerId });

    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () =>
        checkout.claim({ orderId: order.id, vendorId, reservationId: reservation.id }),
      ),
    );

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await stockOf(db, productId)).toBe(3);
    expect(
      (await outboxFor(db, order.id)).filter((e) => e.event_type === 'order.placed'),
    ).toHaveLength(1);
  });

  it('rejects a reservation made for a different cart', async () => {
    const productId = await createProduct(db, vendorId, 5);
    const otherCustomer = await createUser(db);
    const reservation = await checkout.lockCart({
      vendorId,
      customerId: otherCustomer,
      items: [{ productId, quantity: 1 }],
    });
    const order = await createOrder(db, { vendorId, customerId });

    await expect(
      checkout.claim({ orderId: order.id, vendorId, reservationId: reservation.id }),
    ).rejects.toThrow('reservation belongs to another cart');
  });

  it('releases an abandoned checkout so the stock is lockable again at once', async () => {
    const productId = await createProduct(db, vendorId, 2);
    const reservation = await checkout.lockCart({
      vendorId,
      customerId,
      items: [{ productId, quantity: 2 }],
    });

    await expect(checkout.releaseCart(vendorId, reservation.id)).resolves.toBe(true);

    await expect(
      checkout.lockCart({ vendorId, customerId, items: [{ productId, quantity: 2 }] }),
    ).resolves.toBeDefined();
  });
});
