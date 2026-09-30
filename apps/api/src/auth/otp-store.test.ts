import { createHmac } from 'node:crypto';

import type { RedisConnectionPool } from '../infra/redis-pool';
import { otpSmsText } from './otp-auth-service';
import { generateOtpCode, OtpStore } from './otp-store';

describe('generateOtpCode', () => {
  it('always returns exactly 6 digits, keeping leading zeros', () => {
    const codes = Array.from({ length: 5000 }, generateOtpCode);

    for (const code of codes) expect(code).toMatch(/^[0-9]{6}$/);
    expect(codes.some((code) => code.startsWith('0'))).toBe(true);
    expect(new Set(codes).size).toBeGreaterThan(4900);
  });
});

describe('OtpStore.digest', () => {
  const store = (pepper: string) =>
    new OtpStore({} as RedisConnectionPool, createHmac('sha256', pepper).digest());

  it('is a keyed HMAC of phone and code that never contains the code', () => {
    const digest = store('pepper').digest('+9779800000001', '042187');

    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(digest).not.toContain('042187');
    expect(store('pepper').digest('+9779800000001', '042187')).toBe(digest);
    expect(store('pepper').digest('+9779800000002', '042187')).not.toBe(digest);
    expect(store('other').digest('+9779800000001', '042187')).not.toBe(digest);
  });

  it('uses the SPEC-derived defaults: 2 min code, 60 s resend cooldown', () => {
    const defaults = store('pepper');

    expect(defaults.ttlMs).toBe(120_000);
    expect(defaults.cooldownMs).toBe(60_000);
  });
});

describe('otpSmsText', () => {
  it('states the code and its lifetime in one plain-ASCII SMS segment', () => {
    const text = otpSmsText('042187', 120);

    expect(text).toContain('042187');
    expect(text).toContain('2 minutes');
    expect(text.length).toBeLessThanOrEqual(160);
    expect(/^[\x20-\x7e]+$/.test(text)).toBe(true);
  });
});
