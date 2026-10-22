import { createHmac, randomInt } from 'node:crypto';

import {
  OTP_CODE_LENGTH,
  OTP_MAX_VERIFY_ATTEMPTS,
  OTP_RESEND_COOLDOWN_SECONDS,
  OTP_TTL_SECONDS,
} from '@hamro-pasal/shared-types';

import type { RedisConnectionPool } from '../infra/redis-pool';

export interface OtpStoreOptions {
  /** Tests only: shorter windows. Production uses the shared-types constants. */
  readonly ttlMs?: number;
  readonly cooldownMs?: number;
  /**
   * 2026-10-21 (OTP_ADMIN_REVEAL): seals each code beside its digest so a Super Admin can reveal
   * it while it is live. Absent: only the digest is stored and no code can ever be read back.
   */
  readonly revealCipher?: OtpRevealCipher | null;
}

/** Seals and opens a code (AES-256-GCM; CredentialCipher fits). */
export interface OtpRevealCipher {
  seal(secret: string): Buffer;
  open(sealed: Buffer): string;
}

/** A live code as the Authentication Logs reveal it. */
export interface LiveOtp {
  readonly code: string;
  readonly expiresInMs: number;
  readonly attemptsUsed: number;
}

export type OtpCheck =
  | { readonly outcome: 'VALID' }
  /** Wrong code; the stored code stays valid for `attemptsRemaining` more tries. */
  | { readonly outcome: 'WRONG'; readonly attemptsRemaining: number }
  /** Wrong code on the last allowed attempt: the stored code was deleted. */
  | { readonly outcome: 'ATTEMPTS_EXCEEDED' }
  /** No code for this phone: never sent, expired, already used or burned. */
  | { readonly outcome: 'MISSING' };

export const otpKeys = {
  code: (phone: string) => `otp:code:${phone}`,
  cooldown: (phone: string) => `otp:cooldown:${phone}`,
};

/**
 * One atomic step per verification attempt: count it, compare the digest, and delete the code on
 * success (single use) or on the last allowed failure. Concurrent attempts serialise in Redis, so
 * one code can never mint two sessions.
 * Returns { 1 } valid, { 0, attempts } wrong, { -2 } attempts exceeded, { -1 } missing.
 */
const CHECK_AND_CONSUME = `
local digest = redis.call('HGET', KEYS[1], 'digest')
if not digest then return {-1} end
local attempts = redis.call('HINCRBY', KEYS[1], 'attempts', 1)
if digest == ARGV[1] then
  redis.call('DEL', KEYS[1])
  return {1}
end
if attempts >= tonumber(ARGV[2]) then
  redis.call('DEL', KEYS[1])
  return {-2}
end
return {0, attempts}`;

/** A uniformly random code with leading zeros kept ("004271"). */
export function generateOtpCode(): string {
  return String(randomInt(0, 10 ** OTP_CODE_LENGTH)).padStart(OTP_CODE_LENGTH, '0');
}

/**
 * OTP codes in Redis (SPEC: Redis for rate limiting). Only a keyed HMAC of phone + code is stored,
 * never the code itself, so a Redis dump does not reveal live codes. The code expires after 2 min;
 * a per-phone cooldown throttles resends.
 */
export class OtpStore {
  readonly ttlMs: number;
  readonly cooldownMs: number;
  private readonly revealCipher: OtpRevealCipher | null;

  constructor(
    private readonly pool: RedisConnectionPool,
    private readonly pepper: Buffer,
    options: OtpStoreOptions = {},
  ) {
    this.ttlMs = options.ttlMs ?? OTP_TTL_SECONDS * 1000;
    this.cooldownMs = options.cooldownMs ?? OTP_RESEND_COOLDOWN_SECONDS * 1000;
    this.revealCipher = options.revealCipher ?? null;
  }

  /** Whether codes are kept revealable (OTP_ADMIN_REVEAL). */
  get revealEnabled(): boolean {
    return this.revealCipher !== null;
  }

  digest(phone: string, code: string): string {
    return createHmac('sha256', this.pepper).update(`${phone}:${code}`).digest('hex');
  }

  /**
   * Starts the resend cooldown. Returns the milliseconds left if one is already running (the
   * caller must not send), or null when this call may issue a code.
   */
  async claimCooldown(phone: string): Promise<number | null> {
    return this.pool.withConnection(async (redis) => {
      const claimed = await redis.set(otpKeys.cooldown(phone), '1', 'PX', this.cooldownMs, 'NX');
      if (claimed === 'OK') return null;
      return Math.max(await redis.pttl(otpKeys.cooldown(phone)), 0);
    });
  }

  /** Replaces any previous code for this phone (an older SMS stops working). */
  async save(phone: string, code: string): Promise<void> {
    const key = otpKeys.code(phone);
    await this.pool.withConnection(async (redis) => {
      await redis
        .multi()
        .del(key)
        .hset(key, {
          digest: this.digest(phone, code),
          attempts: 0,
          ...(this.revealCipher === null
            ? {}
            : { sealed: this.revealCipher.seal(code).toString('base64') }),
        })
        .pexpire(key, this.ttlMs)
        .exec();
    });
  }

  /** Undoes a send whose SMS failed: no dangling code, and the customer may retry at once. */
  async discard(phone: string): Promise<void> {
    await this.pool.withConnection(async (redis) => {
      await redis.del(otpKeys.code(phone), otpKeys.cooldown(phone));
    });
  }

  /**
   * 2026-10-21: the live code of a number, for the Authentication Logs. Reads only: no attempt is
   * counted and the code stays usable. Null when reveal is off, or no code is live.
   */
  async peek(phone: string): Promise<LiveOtp | null> {
    const cipher = this.revealCipher;
    if (cipher === null) return null;
    return this.pool.withConnection(async (redis) => {
      const key = otpKeys.code(phone);
      const [fields, ttl] = await Promise.all([redis.hgetall(key), redis.pttl(key)]);
      const sealed = fields.sealed;
      if (sealed === undefined || ttl <= 0) return null;
      return {
        code: cipher.open(Buffer.from(sealed, 'base64')),
        expiresInMs: ttl,
        attemptsUsed: Number(fields.attempts ?? 0),
      };
    });
  }

  /** Whether a revealable code is live for each number (one round trip). */
  async revealable(phones: readonly string[]): Promise<Set<string>> {
    if (this.revealCipher === null || phones.length === 0) return new Set();
    const live = await this.pool.withConnection((redis) =>
      Promise.all(phones.map((phone) => redis.hexists(otpKeys.code(phone), 'sealed'))),
    );
    return new Set(phones.filter((_phone, index) => live[index] === 1));
  }

  async checkAndConsume(phone: string, code: string): Promise<OtpCheck> {
    const result: unknown = await this.pool.withConnection((redis) =>
      redis.eval(
        CHECK_AND_CONSUME,
        1,
        otpKeys.code(phone),
        this.digest(phone, code),
        String(OTP_MAX_VERIFY_ATTEMPTS),
      ),
    );
    const [status, attempts] = Array.isArray(result) ? (result as unknown[]) : [];
    switch (status) {
      case 1:
        return { outcome: 'VALID' };
      case 0:
        return {
          outcome: 'WRONG',
          attemptsRemaining: OTP_MAX_VERIFY_ATTEMPTS - Number(attempts),
        };
      case -2:
        return { outcome: 'ATTEMPTS_EXCEEDED' };
      case -1:
        return { outcome: 'MISSING' };
      default:
        throw new Error(`Unexpected OTP check result ${JSON.stringify(result)}`);
    }
  }
}
