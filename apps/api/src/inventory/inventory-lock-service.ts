import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

import { INVENTORY_LOCK_TTL_SECONDS } from '@hamro-pasal/shared-types';
import type { Redis } from 'ioredis';
import { z } from 'zod';

import type { RedisConnectionPool } from '../infra/redis-pool';
import {
  InsufficientStockError,
  InvalidCartError,
  ProductUnavailableError,
  ReservationContentionError,
  type StockShortfall,
} from './errors';
import type { StockReader } from './stock-reader';

/*
 * SPEC §3: the 10-minute inventory lock.
 *
 * Redis layout (the `{vendorId}` hash tag keeps a single-vendor cart's keys in one cluster slot,
 * so multi-key WATCH/MULTI work on Redis Cluster):
 *
 *   inv:{vendorId}:res:{reservationId}  STRING (JSON)  PX 600000   <- the lock; its TTL is the
 *                                                         session clock (/api/cart/lock-status)
 *   inv:{vendorId}:holds:{productId}    HASH reservationId -> qty    <- per-SKU index of holds
 *
 * Availability = products.stock_quantity (PostgreSQL) - live holds. A hold counts only while its
 * reservation key exists, so when Redis evicts an expired reservation, its quantity is released
 * automatically. Stale hash fields are pruned on the next reservation for that SKU, and the
 * hash's own TTL is refreshed to the newest hold's expiry so idle SKUs clean themselves up.
 *
 * Atomicity: WATCH the SKUs' hold hashes -> read stock and live holds -> MULTI writes -> EXEC.
 * Any concurrent reserve/release/claim touches a watched hash, so EXEC returns null and the
 * attempt is retried with fresh numbers. No interleaving can over-allocate.
 */

export const INVENTORY_LOCK_TTL_MS = INVENTORY_LOCK_TTL_SECONDS * 1000;

export interface CartLine {
  readonly productId: string;
  readonly quantity: number;
}

export interface LockRequest {
  readonly vendorId: string;
  readonly customerId: string;
  readonly items: readonly CartLine[];
}

export interface InventoryReservation {
  readonly id: string;
  readonly vendorId: string;
  readonly customerId: string;
  readonly items: readonly CartLine[];
  readonly lockedAt: Date;
  readonly expiresAt: Date;
}

export interface ReservationStatus {
  readonly reservation: InventoryReservation;
  /** Remaining lock time. SPEC edge case 1: resume checkout while > 0. */
  readonly ttlMs: number;
}

export interface InventoryLockOptions {
  /** Lock lifetime. Always 600 000 in production (SPEC §3); overridable only for tests. */
  readonly ttlMs?: number;
  readonly maxAttempts?: number;
  readonly now?: () => number;
}

const storedReservationSchema = z.strictObject({
  id: z.uuid(),
  vendorId: z.uuid(),
  customerId: z.uuid(),
  items: z.array(z.strictObject({ productId: z.uuid(), quantity: z.number().int().positive() })),
  lockedAt: z.number(),
  expiresAt: z.number(),
});

export const inventoryKeys = {
  reservation: (vendorId: string, reservationId: string) =>
    `inv:{${vendorId}}:res:${reservationId}`,
  holds: (vendorId: string, productId: string) => `inv:{${vendorId}}:holds:${productId}`,
};

export class InventoryLockService {
  private readonly ttlMs: number;
  private readonly maxAttempts: number;
  private readonly now: () => number;

  constructor(
    private readonly pool: RedisConnectionPool,
    private readonly stock: StockReader,
    options: InventoryLockOptions = {},
  ) {
    this.ttlMs = options.ttlMs ?? INVENTORY_LOCK_TTL_MS;
    this.maxAttempts = options.maxAttempts ?? 50;
    this.now = options.now ?? Date.now;
  }

  /** Atomically locks every line of a single-vendor cart for exactly `ttlMs`, or nothing. */
  async reserve(request: LockRequest): Promise<InventoryReservation> {
    const items = normaliseLines(request.items);
    const reservationId = randomUUID();

    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      const reservation = await this.pool.withConnection((redis) =>
        this.tryReserve(redis, reservationId, request, items),
      );
      if (reservation !== null) {
        return reservation;
      }
      await sleep(Math.floor(Math.random() * 5 * attempt));
    }
    throw new ReservationContentionError(this.maxAttempts);
  }

  async getStatus(vendorId: string, reservationId: string): Promise<ReservationStatus | null> {
    return this.pool.withConnection(async (redis) => {
      const key = inventoryKeys.reservation(vendorId, reservationId);
      const [raw, ttlMs] = await Promise.all([redis.get(key), redis.pttl(key)]);
      if (raw === null || ttlMs <= 0) {
        return null;
      }
      return { reservation: parseReservation(raw), ttlMs };
    });
  }

  /**
   * Deletes the lock and its holds, so the quantities become available immediately. Used both
   * when a customer abandons checkout and after a successful claim. Idempotent: returns false
   * if the lock was already gone.
   */
  async release(vendorId: string, reservationId: string): Promise<boolean> {
    const key = inventoryKeys.reservation(vendorId, reservationId);
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      const outcome = await this.pool.withConnection(async (redis) => {
        await redis.watch(key);
        const raw = await redis.get(key);
        if (raw === null) {
          await redis.unwatch();
          return 'absent' as const;
        }
        const reservation = parseReservation(raw);
        const multi = redis.multi().del(key);
        for (const line of reservation.items) {
          multi.hdel(inventoryKeys.holds(vendorId, line.productId), reservationId);
        }
        return assertExecResult(await multi.exec()) ? ('released' as const) : ('conflict' as const);
      });
      if (outcome !== 'conflict') {
        return outcome === 'released';
      }
    }
    throw new ReservationContentionError(this.maxAttempts);
  }

  /** One optimistic attempt. Returns null when a watched key changed (caller retries). */
  private async tryReserve(
    redis: Redis,
    reservationId: string,
    request: LockRequest,
    items: readonly CartLine[],
  ): Promise<InventoryReservation | null> {
    const holdKeys = items.map((line) => inventoryKeys.holds(request.vendorId, line.productId));
    await redis.watch(...holdKeys);
    try {
      const stock = await this.stock.getStock(
        request.vendorId,
        items.map((line) => line.productId),
      );
      const missing = items.filter((line) => !stock.has(line.productId)).map((l) => l.productId);
      if (missing.length > 0) {
        throw new ProductUnavailableError(missing);
      }

      const holds = await readLiveHolds(redis, request.vendorId, holdKeys);
      const shortfalls: StockShortfall[] = [];
      items.forEach((line, index) => {
        const available = (stock.get(line.productId) ?? 0) - (holds[index]?.heldQuantity ?? 0);
        if (line.quantity > available) {
          shortfalls.push({
            productId: line.productId,
            requested: line.quantity,
            available: Math.max(0, available),
          });
        }
      });
      if (shortfalls.length > 0) {
        throw new InsufficientStockError(shortfalls);
      }

      const lockedAt = this.now();
      const reservation: InventoryReservation = {
        id: reservationId,
        vendorId: request.vendorId,
        customerId: request.customerId,
        items,
        lockedAt: new Date(lockedAt),
        expiresAt: new Date(lockedAt + this.ttlMs),
      };

      const multi = redis
        .multi()
        .set(
          inventoryKeys.reservation(request.vendorId, reservationId),
          serialiseReservation(reservation),
          'PX',
          this.ttlMs,
        );
      items.forEach((line, index) => {
        const holdKey = holdKeys[index] ?? '';
        const stale = holds[index]?.staleReservationIds ?? [];
        if (stale.length > 0) {
          multi.hdel(holdKey, ...stale);
        }
        multi.hset(holdKey, reservationId, line.quantity);
        // Every live hold expires no later than this new one, so this bounds the index lifetime.
        multi.pexpire(holdKey, this.ttlMs);
      });

      return assertExecResult(await multi.exec()) ? reservation : null;
    } catch (error: unknown) {
      await redis.unwatch();
      throw error;
    }
  }
}

interface SkuHolds {
  readonly heldQuantity: number;
  readonly staleReservationIds: readonly string[];
}

/** Sums the holds whose reservation key still exists; reports the rest as stale. */
async function readLiveHolds(
  redis: Redis,
  vendorId: string,
  holdKeys: readonly string[],
): Promise<SkuHolds[]> {
  const hashes = await Promise.all(holdKeys.map((key) => redis.hgetall(key)));
  const reservationIds = [...new Set(hashes.flatMap((hash) => Object.keys(hash)))];
  const alive = new Set<string>();
  if (reservationIds.length > 0) {
    const flags = await Promise.all(
      reservationIds.map((id) => redis.exists(inventoryKeys.reservation(vendorId, id))),
    );
    reservationIds.forEach((id, index) => {
      if (flags[index] === 1) alive.add(id);
    });
  }

  return hashes.map((hash) => {
    let heldQuantity = 0;
    const staleReservationIds: string[] = [];
    for (const [reservationId, quantity] of Object.entries(hash)) {
      if (alive.has(reservationId)) {
        heldQuantity += Number(quantity);
      } else {
        staleReservationIds.push(reservationId);
      }
    }
    return { heldQuantity, staleReservationIds };
  });
}

/** true = committed, false = aborted by WATCH. Throws if any queued command failed. */
function assertExecResult(result: [Error | null, unknown][] | null): boolean {
  if (result === null) {
    return false;
  }
  const failure = result.find(([error]) => error !== null);
  if (failure?.[0] != null) {
    throw failure[0];
  }
  return true;
}

function normaliseLines(lines: readonly CartLine[]): CartLine[] {
  if (lines.length === 0) {
    throw new InvalidCartError('Cart is empty');
  }
  const merged = new Map<string, number>();
  for (const line of lines) {
    if (!Number.isInteger(line.quantity) || line.quantity <= 0) {
      throw new InvalidCartError(`Quantity for ${line.productId} must be a positive integer`);
    }
    merged.set(line.productId, (merged.get(line.productId) ?? 0) + line.quantity);
  }
  return [...merged].map(([productId, quantity]) => ({ productId, quantity }));
}

function serialiseReservation(reservation: InventoryReservation): string {
  return JSON.stringify({
    ...reservation,
    lockedAt: reservation.lockedAt.getTime(),
    expiresAt: reservation.expiresAt.getTime(),
  });
}

function parseReservation(raw: string): InventoryReservation {
  const stored = storedReservationSchema.parse(JSON.parse(raw));
  return {
    ...stored,
    lockedAt: new Date(stored.lockedAt),
    expiresAt: new Date(stored.expiresAt),
  };
}
