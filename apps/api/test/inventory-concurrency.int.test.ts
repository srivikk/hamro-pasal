import type { Database } from '@hamro-pasal/db';
import { Redis } from 'ioredis';

import type { RedisConnectionPool } from '../src/infra/redis-pool';
import { InsufficientStockError } from '../src/inventory/errors';
import {
  InventoryLockService,
  inventoryKeys,
  type CartLine,
  type InventoryReservation,
} from '../src/inventory/inventory-lock-service';
import { DrizzleStockReader } from '../src/inventory/stock-reader';
import {
  createProduct,
  createUser,
  createVendor,
  testDatabase,
  testRedisPool,
  testRedisUrl,
} from './support/fixtures';

/**
 * Real Redis + PostgreSQL. Parallel checkouts race on the same SKUs through 20 dedicated
 * connections; WATCH/MULTI/EXEC must never grant more than products.stock_quantity.
 */
describe('InventoryLockService under concurrency (real Redis)', () => {
  let db: Database;
  let pool: RedisConnectionPool;
  let inspector: Redis;
  let service: InventoryLockService;
  let vendorId: string;
  let customerId: string;

  beforeAll(async () => {
    db = testDatabase();
    pool = testRedisPool(20);
    inspector = new Redis(testRedisUrl());
    service = new InventoryLockService(pool, new DrizzleStockReader(db));
    vendorId = await createVendor(db);
    customerId = await createUser(db);
  });

  afterAll(async () => {
    await pool.close();
    await inspector.quit();
    await db.$client.end();
  });

  const checkout = (items: CartLine[], svc = service) =>
    svc.reserve({ vendorId, customerId, items });

  /** Sum of live holds for a SKU, read straight from Redis. */
  async function heldInRedis(productId: string): Promise<number> {
    const holds = await inspector.hgetall(inventoryKeys.holds(vendorId, productId));
    let total = 0;
    for (const [reservationId, quantity] of Object.entries(holds)) {
      if ((await inspector.exists(inventoryKeys.reservation(vendorId, reservationId))) === 1) {
        total += Number(quantity);
      }
    }
    return total;
  }

  function partition(results: PromiseSettledResult<InventoryReservation>[]) {
    const granted = results.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
    const rejected = results.flatMap((r) => (r.status === 'rejected' ? [r.reason as unknown] : []));
    return { granted, rejected };
  }

  it('sets the real Redis TTL to 600 s', async () => {
    const productId = await createProduct(db, vendorId, 1);

    const reservation = await checkout([{ productId, quantity: 1 }]);
    const pttl = await inspector.pttl(inventoryKeys.reservation(vendorId, reservation.id));

    expect(pttl).toBeGreaterThan(599_000);
    expect(pttl).toBeLessThanOrEqual(600_000);
  });

  it('grants exactly the stock to 100 parallel single-unit checkouts on one SKU', async () => {
    const productId = await createProduct(db, vendorId, 10);

    const results = await Promise.allSettled(
      Array.from({ length: 100 }, () => checkout([{ productId, quantity: 1 }])),
    );
    const { granted, rejected } = partition(results);

    expect(granted).toHaveLength(10);
    expect(rejected).toHaveLength(90);
    expect(rejected.every((e) => e instanceof InsufficientStockError)).toBe(true);
    expect(await heldInRedis(productId)).toBe(10);
  });

  it('never over-allocates with random quantities', async () => {
    const productId = await createProduct(db, vendorId, 25);

    const results = await Promise.allSettled(
      Array.from({ length: 60 }, (_, i) => checkout([{ productId, quantity: (i % 4) + 1 }])),
    );
    const { granted, rejected } = partition(results);
    const grantedUnits = granted.reduce((t, r) => t + (r.items[0]?.quantity ?? 0), 0);

    expect(grantedUnits).toBeLessThanOrEqual(25);
    expect(await heldInRedis(productId)).toBe(grantedUnits);
    expect(rejected.every((e) => e instanceof InsufficientStockError)).toBe(true);
    // Whatever is left over is smaller than the smallest request that was refused at the end.
    expect(25 - grantedUnits).toBeLessThan(4);
  });

  it('keeps multi-SKU carts atomic when they contend on overlapping SKUs', async () => {
    const dal = await createProduct(db, vendorId, 7);
    const bhat = await createProduct(db, vendorId, 5);

    const results = await Promise.allSettled(
      Array.from({ length: 40 }, (_, i) =>
        checkout(
          i % 2 === 0
            ? [
                { productId: dal, quantity: 1 },
                { productId: bhat, quantity: 1 },
              ]
            : [{ productId: dal, quantity: 1 }],
        ),
      ),
    );
    const { granted } = partition(results);
    const units = (productId: string) =>
      granted.reduce(
        (t, r) => t + (r.items.find((l) => l.productId === productId)?.quantity ?? 0),
        0,
      );

    expect(units(dal)).toBe(7);
    expect(units(bhat)).toBeLessThanOrEqual(5);
    expect(await heldInRedis(dal)).toBe(7);
    expect(await heldInRedis(bhat)).toBe(units(bhat));
  });

  it('makes quantity available again when Redis evicts an expired lock', async () => {
    const productId = await createProduct(db, vendorId, 3);
    const shortLived = new InventoryLockService(pool, new DrizzleStockReader(db), { ttlMs: 300 });

    await checkout([{ productId, quantity: 3 }], shortLived);
    await expect(checkout([{ productId, quantity: 1 }])).rejects.toBeInstanceOf(
      InsufficientStockError,
    );

    await new Promise((resolve) => setTimeout(resolve, 600));

    await expect(checkout([{ productId, quantity: 3 }])).resolves.toBeDefined();
  });

  it('releases under contention without losing or duplicating holds', async () => {
    const productId = await createProduct(db, vendorId, 5);
    const initial = await Promise.all(
      Array.from({ length: 5 }, () => checkout([{ productId, quantity: 1 }])),
    );

    const [releases, contenders] = await Promise.all([
      Promise.all(initial.map((r) => service.release(vendorId, r.id))),
      Promise.allSettled(Array.from({ length: 20 }, () => checkout([{ productId, quantity: 1 }]))),
    ]);
    const { granted } = partition(contenders);

    expect(releases.every(Boolean)).toBe(true);
    expect(granted.length).toBeLessThanOrEqual(5);
    expect(await heldInRedis(productId)).toBe(granted.length);
  });

  it('rejects a product of another vendor', async () => {
    const otherVendor = await createVendor(db);
    const foreign = await createProduct(db, otherVendor, 10);

    await expect(checkout([{ productId: foreign, quantity: 1 }])).rejects.toThrow(
      'Products unavailable',
    );
  });
});
