import { randomUUID } from 'node:crypto';

import RedisMock from 'ioredis-mock';

import { RedisConnectionPool } from '../infra/redis-pool';
import { InsufficientStockError, InvalidCartError, ProductUnavailableError } from './errors';
import {
  INVENTORY_LOCK_TTL_MS,
  InventoryLockService,
  inventoryKeys,
} from './inventory-lock-service';
import type { StockReader } from './stock-reader';

/**
 * SPEC §3 / verification #1 at the unit level: Redis is replaced by ioredis-mock, whose key
 * expiry is computed from Date.now(), and Jest's fake clock is advanced across the 600 s
 * boundary without waiting.
 */
describe('InventoryLockService (unit, simulated clock)', () => {
  const T0 = new Date('2026-09-29T10:00:00.000Z').getTime();
  const vendorId = randomUUID();
  const rice = randomUUID();
  const tea = randomUUID();

  let redis: InstanceType<typeof RedisMock>;
  let service: InventoryLockService;

  const stock: StockReader = {
    getStock: (_vendorId, productIds) =>
      Promise.resolve(
        new Map(
          productIds
            .filter((id) => id === rice || id === tea)
            .map((id): [string, number] => [id, id === rice ? 5 : 2]),
        ),
      ),
  };

  const lock = (quantity: number, productId = rice) =>
    service.reserve({ vendorId, customerId: randomUUID(), items: [{ productId, quantity }] });

  beforeEach(async () => {
    // Only Date is faked; the mock's promise plumbing keeps using real timers.
    jest.useFakeTimers({
      doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'setInterval', 'queueMicrotask'],
    });
    jest.setSystemTime(T0);
    redis = new RedisMock();
    await redis.flushall();
    service = new InventoryLockService(new RedisConnectionPool(() => redis, 1), stock);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('uses exactly the SPEC lock duration of 600 seconds', () => {
    expect(INVENTORY_LOCK_TTL_MS).toBe(600_000);
  });

  it('writes the reservation key with a 600 000 ms TTL', async () => {
    const reservation = await lock(2);

    const pttl = await redis.pttl(inventoryKeys.reservation(vendorId, reservation.id));

    expect(pttl).toBe(600_000);
    expect(reservation.lockedAt.getTime()).toBe(T0);
    expect(reservation.expiresAt.getTime()).toBe(T0 + 600_000);
  });

  it('holds the locked quantity until the TTL elapses, then evicts it', async () => {
    const first = await lock(5);

    await expect(lock(1)).rejects.toBeInstanceOf(InsufficientStockError);

    jest.setSystemTime(T0 + 599_999);
    expect(await service.getStatus(vendorId, first.id)).toMatchObject({ ttlMs: 1 });
    await expect(lock(1)).rejects.toBeInstanceOf(InsufficientStockError);

    jest.setSystemTime(T0 + 600_000);
    expect(await service.getStatus(vendorId, first.id)).toBeNull();
    await expect(lock(5)).resolves.toMatchObject({ items: [{ productId: rice, quantity: 5 }] });
  });

  it('prunes the evicted reservation from the SKU hold index on the next lock', async () => {
    const expired = await lock(3);
    jest.setSystemTime(T0 + 600_000);

    const fresh = await lock(1);

    expect(await redis.hgetall(inventoryKeys.holds(vendorId, rice))).toEqual({ [fresh.id]: '1' });
    expect(expired.id).not.toBe(fresh.id);
  });

  it('reports the remaining TTL for lock-status polling (SPEC edge case 1)', async () => {
    const reservation = await lock(1);
    jest.setSystemTime(T0 + 420_000);

    const status = await service.getStatus(vendorId, reservation.id);

    expect(status?.ttlMs).toBe(180_000);
    expect(status?.reservation.id).toBe(reservation.id);
  });

  it('frees the quantity immediately on release, and release is idempotent', async () => {
    const reservation = await lock(5);

    await expect(service.release(vendorId, reservation.id)).resolves.toBe(true);
    await expect(service.release(vendorId, reservation.id)).resolves.toBe(false);
    await expect(lock(5)).resolves.toBeDefined();
  });

  it('locks multi-line carts all-or-nothing', async () => {
    await lock(2, tea);

    const error: unknown = await service
      .reserve({
        vendorId,
        customerId: randomUUID(),
        items: [
          { productId: rice, quantity: 1 },
          { productId: tea, quantity: 1 },
        ],
      })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(InsufficientStockError);
    expect((error as InsufficientStockError).shortfalls).toEqual([
      { productId: tea, requested: 1, available: 0 },
    ]);
    expect(await redis.hgetall(inventoryKeys.holds(vendorId, rice))).toEqual({});
  });

  it('merges duplicate lines and validates the cart', async () => {
    const merged = await service.reserve({
      vendorId,
      customerId: randomUUID(),
      items: [
        { productId: rice, quantity: 2 },
        { productId: rice, quantity: 3 },
      ],
    });
    expect(merged.items).toEqual([{ productId: rice, quantity: 5 }]);

    await expect(
      service.reserve({ vendorId, customerId: randomUUID(), items: [] }),
    ).rejects.toBeInstanceOf(InvalidCartError);
    await expect(lock(1.5)).rejects.toBeInstanceOf(InvalidCartError);
    await expect(lock(1, randomUUID())).rejects.toBeInstanceOf(ProductUnavailableError);
  });
});
