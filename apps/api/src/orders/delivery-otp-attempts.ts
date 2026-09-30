import { DELIVERY_OTP_LOCKOUT_SECONDS, DELIVERY_OTP_MAX_ATTEMPTS } from '@hamro-pasal/shared-types';

import type { RedisConnectionPool } from '../infra/redis-pool';

export interface DeliveryOtpAttemptOptions {
  /** Tests only: a shorter lockout. Production uses DELIVERY_OTP_LOCKOUT_SECONDS. */
  readonly lockoutMs?: number;
}

export interface DeliveryOtpFailure {
  /** Wrong codes for this order inside the current window, this one included. */
  readonly failures: number;
  /** Milliseconds until the count is forgotten (the lockout, once the limit is reached). */
  readonly ttlMs: number;
}

export const deliveryOtpKeys = {
  failures: (orderId: string) => `delivery-otp:failures:${orderId}`,
};

/**
 * Counts one wrong code atomically. The first failure opens a window of the lockout length; the
 * failure that reaches the limit restarts it, so a locked order stays locked for the full lockout
 * however the earlier failures were spread. Returns { failures, pttl }.
 */
const RECORD_FAILURE = `
local failures = redis.call('INCR', KEYS[1])
if failures == 1 or failures == tonumber(ARGV[1]) then
  redis.call('PEXPIRE', KEYS[1], ARGV[2])
end
return {failures, redis.call('PTTL', KEYS[1])}`;

/**
 * Brute-force guard for the 4-digit handoff code (SPEC: Redis for rate limiting). Wrong codes are
 * counted per order, whoever types them; DELIVERY_OTP_MAX_ATTEMPTS of them lock the order for the
 * lockout. The caller holds the order row lock (`SELECT … FOR UPDATE`) around check and count, so
 * concurrent guesses for one order are serialised and none can slip past the limit.
 */
export class DeliveryOtpAttempts {
  readonly lockoutMs: number;

  constructor(
    private readonly pool: RedisConnectionPool,
    options: DeliveryOtpAttemptOptions = {},
  ) {
    this.lockoutMs = options.lockoutMs ?? DELIVERY_OTP_LOCKOUT_SECONDS * 1000;
  }

  /** Milliseconds the order stays locked, or null when codes may be tried. */
  async lockedForMs(orderId: string): Promise<number | null> {
    return this.pool.withConnection(async (redis) => {
      const key = deliveryOtpKeys.failures(orderId);
      const failures = Number((await redis.get(key)) ?? 0);
      if (failures < DELIVERY_OTP_MAX_ATTEMPTS) return null;
      const ttlMs = await redis.pttl(key);
      return ttlMs > 0 ? ttlMs : null;
    });
  }

  async recordFailure(orderId: string): Promise<DeliveryOtpFailure> {
    const result: unknown = await this.pool.withConnection((redis) =>
      redis.eval(
        RECORD_FAILURE,
        1,
        deliveryOtpKeys.failures(orderId),
        String(DELIVERY_OTP_MAX_ATTEMPTS),
        String(this.lockoutMs),
      ),
    );
    const [failures, ttlMs] = Array.isArray(result) ? (result as unknown[]) : [];
    if (typeof failures !== 'number' || typeof ttlMs !== 'number') {
      throw new Error(`Unexpected delivery OTP counter result ${JSON.stringify(result)}`);
    }
    return { failures, ttlMs };
  }

  /** After a successful delivery: the order needs no guard any more. */
  async clear(orderId: string): Promise<void> {
    await this.pool.withConnection(async (redis) => {
      await redis.del(deliveryOtpKeys.failures(orderId));
    });
  }
}
