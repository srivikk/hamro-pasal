import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

import type { RedisConnectionPool } from './redis-pool';

/** Deletes the key only if it still holds our token, so we never release someone else's lock. */
const RELEASE_IF_OWNER = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0`;

export class MutexTimeoutError extends Error {
  constructor(readonly key: string) {
    super(`Timed out waiting for ${key}`);
    this.name = 'MutexTimeoutError';
  }
}

export interface RedisMutexOptions {
  /** Safety expiry if the holder crashes; must exceed the longest critical section. */
  readonly leaseMs?: number;
  readonly waitMs?: number;
  readonly pollMs?: number;
}

/**
 * A per-key mutual exclusion lock in Redis (SET NX PX + owner-checked release). It holds no
 * database connection while waiting, so it cannot exhaust the PostgreSQL pool.
 */
export class RedisKeyedMutex {
  private readonly leaseMs: number;
  private readonly waitMs: number;
  private readonly pollMs: number;

  constructor(
    private readonly pool: RedisConnectionPool,
    options: RedisMutexOptions = {},
  ) {
    this.leaseMs = options.leaseMs ?? 30_000;
    this.waitMs = options.waitMs ?? 15_000;
    this.pollMs = options.pollMs ?? 50;
  }

  async runExclusive<T>(key: string, work: () => Promise<T>): Promise<T> {
    const lockKey = `mutex:${key}`;
    const token = randomUUID();
    const deadline = Date.now() + this.waitMs;

    for (;;) {
      const acquired = await this.pool.withConnection((redis) =>
        redis.set(lockKey, token, 'PX', this.leaseMs, 'NX'),
      );
      if (acquired === 'OK') break;
      if (Date.now() >= deadline) throw new MutexTimeoutError(key);
      await sleep(this.pollMs);
    }

    try {
      return await work();
    } finally {
      await this.pool.withConnection((redis) => redis.eval(RELEASE_IF_OWNER, 1, lockKey, token));
    }
  }
}
