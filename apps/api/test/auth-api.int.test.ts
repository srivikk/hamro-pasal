import { randomInt, randomUUID } from 'node:crypto';

import { users } from '@hamro-pasal/db';
import {
  authTokensResponseSchema,
  otpSendResponseSchema,
  tokenRefreshResponseSchema,
} from '@hamro-pasal/shared-types';
import { eq } from 'drizzle-orm';
import jwt from 'jsonwebtoken';
import request from 'supertest';

import { verifyAccessToken } from '../src/auth/access-token';
import { otpKeys } from '../src/auth/otp-store';
import { verifyRefreshToken } from '../src/auth/refresh-token';
import { SmsDeliveryError, type OutboundSms, type SmsGateway } from '../src/sms/sms-gateway';
import { createUser } from './support/fixtures';
import {
  ACCESS_SECRET,
  bodyOf,
  buildTestApp,
  errorOf,
  REFRESH_SECRET,
  type TestApp,
} from './support/http';

/** A fresh +977 number per test, so resend cooldowns never leak between tests. */
function uniquePhone(): string {
  return `+9779${String(randomInt(0, 1_000_000_000)).padStart(9, '0')}`;
}

/** POST /api/auth/otp/send and /verify over real Express + Redis + PostgreSQL. */
describe('OTP auth API', () => {
  let t: TestApp;

  beforeAll(() => {
    t = buildTestApp();
  });

  afterAll(async () => {
    await t.container.close();
  });

  const send = (phone: unknown, app = t.app) =>
    request(app).post('/api/auth/otp/send').send({ phone });
  const verify = (phone: string, code: string, app = t.app) =>
    request(app).post('/api/auth/otp/verify').send({ phone, code });
  const redis = <T>(work: Parameters<TestApp['container']['redisPool']['withConnection']>[0]) =>
    t.container.redisPool.withConnection(work) as Promise<T>;

  /** The code in the last SMS sent to `phone` (from the in-memory SMS gateway). */
  function codeSentTo(phone: string, sms: readonly OutboundSms[] = t.sms.sent): string {
    const message = sms.filter((m) => m.to === phone).at(-1);
    const code = /\b([0-9]{6})\b/.exec(message?.text ?? '')?.[1];
    if (code === undefined) throw new Error(`No OTP SMS to ${phone}`);
    return code;
  }

  /** Any 6-digit code other than `code`. */
  const wrong = (code: string) => (code === '000000' ? '111111' : '000000');

  describe('POST /api/auth/otp/send', () => {
    it('texts a 6-digit code to the +977 number and keeps it in Redis for exactly 2 minutes', async () => {
      const phone = uniquePhone();

      const res = await send(phone);

      expect(res.status).toBe(200);
      expect(bodyOf(otpSendResponseSchema, res)).toEqual({
        phone,
        expires_in_seconds: 120,
        resend_after_seconds: 60,
      });
      const code = codeSentTo(phone);
      expect(code).toMatch(/^[0-9]{6}$/);

      const [ttlMs, stored, cooldownMs] = await redis<[number, Record<string, string>, number]>(
        async (r) =>
          Promise.all([
            r.pttl(otpKeys.code(phone)),
            r.hgetall(otpKeys.code(phone)),
            r.pttl(otpKeys.cooldown(phone)),
          ]),
      );
      expect(ttlMs).toBeGreaterThan(115_000);
      expect(ttlMs).toBeLessThanOrEqual(120_000);
      expect(cooldownMs).toBeGreaterThan(55_000);
      expect(cooldownMs).toBeLessThanOrEqual(60_000);
      // Only a keyed digest is stored, never the code itself.
      expect(stored).toEqual({
        digest: expect.stringMatching(/^[0-9a-f]{64}$/) as unknown,
        attempts: '0',
      });
      expect(JSON.stringify(stored)).not.toContain(code);
    });

    it('accepts only strictly formatted +977 numbers', async () => {
      const bad = ['9800000001', '+977 9800000001', '+919800000001', '+9771234567890', 42, null];

      const responses = await Promise.all(bad.map((phone) => send(phone)));

      for (const res of responses) {
        expect(res.status).toBe(400);
        expect(errorOf(res).code).toBe('VALIDATION_FAILED');
      }
      expect(t.sms.sent.filter((m) => !m.to.startsWith('+9779'))).toEqual([]);
    });

    it('refuses a resend within the 60 s cooldown and sends no second SMS', async () => {
      const phone = uniquePhone();
      await send(phone);

      const again = await send(phone);

      expect(again.status).toBe(429);
      const error = errorOf(again);
      expect(error.code).toBe('OTP_RESEND_COOLDOWN');
      expect(error.details).toEqual({ retry_after_seconds: expect.any(Number) as unknown });
      expect(
        (error.details as { retry_after_seconds: number }).retry_after_seconds,
      ).toBeLessThanOrEqual(60);
      expect(t.sms.sent.filter((m) => m.to === phone)).toHaveLength(1);
    });

    it('replaces the previous code when a new one is sent after the cooldown', async () => {
      const quick = buildTestApp({ otpOptions: { cooldownMs: 50 } });
      try {
        const phone = uniquePhone();
        await send(phone, quick.app);
        const first = codeSentTo(phone, quick.sms.sent);
        await new Promise((resolve) => setTimeout(resolve, 80));
        await send(phone, quick.app);
        const second = codeSentTo(phone, quick.sms.sent);

        if (first !== second) {
          expect((await verify(phone, first, quick.app)).status).toBe(401);
        }
        expect((await verify(phone, second, quick.app)).status).toBe(200);
      } finally {
        await quick.container.close();
      }
    });

    it('reports a failed SMS as 502 and leaves no code or cooldown behind', async () => {
      const failing: SmsGateway & { sent: OutboundSms[] } = {
        provider: 'SPARROW',
        sent: [],
        send: () => Promise.reject(new SmsDeliveryError('SPARROW', 'HTTP 503')),
      };
      const broken = buildTestApp({ sms: failing });
      try {
        const phone = uniquePhone();

        const res = await send(phone, broken.app);

        expect(res.status).toBe(502);
        expect(errorOf(res).code).toBe('SMS_DELIVERY_FAILED');
        const exists = await broken.container.redisPool.withConnection((r) =>
          r.exists(otpKeys.code(phone), otpKeys.cooldown(phone)),
        );
        expect(exists).toBe(0);
      } finally {
        await broken.container.close();
      }
    });
  });

  describe('POST /api/auth/otp/verify', () => {
    it('creates a customer and mints a 15-min access token and a 7-day refresh token', async () => {
      const phone = uniquePhone();
      await send(phone);

      const res = await verify(phone, codeSentTo(phone));

      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
      const body = bodyOf(authTokensResponseSchema, res);
      expect(body).toMatchObject({
        token_type: 'Bearer',
        access_token_expires_in: 900,
        refresh_token_expires_in: 604_800,
        is_new_user: true,
        user: { role: 'CUSTOMER', first_name: null },
      });
      const [stored] = await t.container.db.select().from(users).where(eq(users.phone, phone));
      expect(stored).toMatchObject({ id: body.user.id, role: 'CUSTOMER', first_name: null });

      // Access token: JWT_ACCESS_SECRET, 900 s, subject = the customer.
      expect(verifyAccessToken(body.access_token, ACCESS_SECRET)).toEqual({
        userId: body.user.id,
        role: 'CUSTOMER',
      });
      const access = jwt.decode(body.access_token) as { exp: number; iat: number };
      expect(access.exp - access.iat).toBe(900);

      // Refresh token: JWT_REFRESH_SECRET, 7 days, and useless as an access token.
      expect(verifyRefreshToken(body.refresh_token, REFRESH_SECRET).userId).toBe(body.user.id);
      const refresh = jwt.decode(body.refresh_token) as { exp: number; iat: number };
      expect(refresh.exp - refresh.iat).toBe(604_800);
      expect(() => verifyRefreshToken(body.refresh_token, ACCESS_SECRET)).toThrow();
      expect(() => verifyAccessToken(body.refresh_token, ACCESS_SECRET)).toThrow();

      // The access token opens customer routes; the refresh token does not.
      const withAccess = await request(t.app)
        .get(`/api/orders/${randomUUID()}`)
        .set('authorization', `Bearer ${body.access_token}`);
      const withRefresh = await request(t.app)
        .get(`/api/orders/${randomUUID()}`)
        .set('authorization', `Bearer ${body.refresh_token}`);
      expect(withAccess.status).toBe(404);
      expect(errorOf(withAccess).code).toBe('ORDER_NOT_FOUND');
      expect(withRefresh.status).toBe(401);
    });

    it('signs in an existing account without creating another, keeping its role', async () => {
      const vendorUserId = await createUser(t.container.db, 'VENDOR');
      const [vendorUser] = await t.container.db
        .select()
        .from(users)
        .where(eq(users.id, vendorUserId));
      const phone = vendorUser?.phone ?? '';
      await send(phone);

      const body = bodyOf(authTokensResponseSchema, await verify(phone, codeSentTo(phone)));

      expect(body.is_new_user).toBe(false);
      expect(body.user).toEqual({ id: vendorUserId, role: 'VENDOR', first_name: 'Test' });
      expect(verifyAccessToken(body.access_token, ACCESS_SECRET).role).toBe('VENDOR');
      expect(await t.container.db.select().from(users).where(eq(users.phone, phone))).toHaveLength(
        1,
      );
    });

    it('accepts each code once, even when submitted concurrently', async () => {
      const phone = uniquePhone();
      await send(phone);
      const code = codeSentTo(phone);

      const results = await Promise.all(Array.from({ length: 5 }, () => verify(phone, code)));

      expect(results.map((r) => r.status).sort()).toEqual([200, 410, 410, 410, 410]);
      expect(errorOf(await verify(phone, code)).code).toBe('OTP_EXPIRED');
      expect(await t.container.db.select().from(users).where(eq(users.phone, phone))).toHaveLength(
        1,
      );
    });

    it('counts wrong codes and burns the code after 5 attempts', async () => {
      const phone = uniquePhone();
      await send(phone);
      const code = codeSentTo(phone);

      const remaining: unknown[] = [];
      for (let attempt = 1; attempt <= 4; attempt += 1) {
        const res = await verify(phone, wrong(code));
        expect(res.status).toBe(401);
        expect(errorOf(res).code).toBe('OTP_INVALID');
        remaining.push((errorOf(res).details as { attempts_remaining: number }).attempts_remaining);
      }
      const fifth = await verify(phone, wrong(code));
      const correctAfterwards = await verify(phone, code);

      expect(remaining).toEqual([4, 3, 2, 1]);
      expect(fifth.status).toBe(429);
      expect(errorOf(fifth).code).toBe('OTP_ATTEMPTS_EXCEEDED');
      expect(correctAfterwards.status).toBe(410);
      expect(errorOf(correctAfterwards).code).toBe('OTP_EXPIRED');
    });

    it('still accepts the right code after fewer than 5 wrong attempts', async () => {
      const phone = uniquePhone();
      await send(phone);
      const code = codeSentTo(phone);
      for (let attempt = 1; attempt <= 4; attempt += 1) await verify(phone, wrong(code));

      expect((await verify(phone, code)).status).toBe(200);
    });

    it('rejects a code once its Redis TTL has run out', async () => {
      const shortLived = buildTestApp({ otpOptions: { ttlMs: 300 } });
      try {
        const phone = uniquePhone();
        await send(phone, shortLived.app);
        const code = codeSentTo(phone, shortLived.sms.sent);
        const ttlMs = await shortLived.container.redisPool.withConnection((r) =>
          r.pttl(otpKeys.code(phone)),
        );
        expect(ttlMs).toBeGreaterThan(0);
        expect(ttlMs).toBeLessThanOrEqual(300);

        await new Promise((resolve) => setTimeout(resolve, 400));
        const res = await verify(phone, code, shortLived.app);

        expect(res.status).toBe(410);
        expect(errorOf(res).code).toBe('OTP_EXPIRED');
      } finally {
        await shortLived.container.close();
      }
    });

    it('rejects a code for a number it was not sent to, and malformed codes', async () => {
      const phone = uniquePhone();
      await send(phone);
      const code = codeSentTo(phone);

      const otherNumber = await verify(uniquePhone(), code);
      const malformed = await verify(phone, '12345');

      expect(otherNumber.status).toBe(410);
      expect(malformed.status).toBe(400);
      expect(errorOf(malformed).code).toBe('VALIDATION_FAILED');
      expect((await verify(phone, code)).status).toBe(200);
    });
  });
  describe('POST /api/auth/token/refresh', () => {
    const refresh = (refreshToken: unknown) =>
      request(t.app).post('/api/auth/token/refresh').send({ refresh_token: refreshToken });

    /** Signs a new customer in through the real OTP flow. */
    async function signIn() {
      const phone = uniquePhone();
      await send(phone);
      return bodyOf(authTokensResponseSchema, await verify(phone, codeSentTo(phone)));
    }

    it('issues a fresh 15-minute access token for a valid refresh token', async () => {
      const session = await signIn();

      const res = await refresh(session.refresh_token);

      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
      const body = bodyOf(tokenRefreshResponseSchema, res);
      expect(body).toMatchObject({ token_type: 'Bearer', access_token_expires_in: 900 });
      expect(verifyAccessToken(body.access_token, ACCESS_SECRET)).toEqual({
        userId: session.user.id,
        role: 'CUSTOMER',
      });
      const decoded = jwt.decode(body.access_token) as { exp: number; iat: number };
      expect(decoded.exp - decoded.iat).toBe(900);
      const works = await request(t.app)
        .get(`/api/orders/${randomUUID()}`)
        .set('authorization', `Bearer ${body.access_token}`);
      expect(works.status).toBe(404);
      // The refresh token is not rotated: it keeps working until its own expiry.
      expect((await refresh(session.refresh_token)).status).toBe(200);
    });

    it('takes the role from the database, not from any token', async () => {
      const session = await signIn();
      await t.container.db
        .update(users)
        .set({ role: 'DRIVER' })
        .where(eq(users.id, session.user.id));

      const body = bodyOf(tokenRefreshResponseSchema, await refresh(session.refresh_token));

      expect(verifyAccessToken(body.access_token, ACCESS_SECRET).role).toBe('DRIVER');
    });

    it('rejects an access token, a forged token, a wrong audience and an expired token', async () => {
      const session = await signIn();
      const sub = session.user.id;
      const signWith = (
        secret: string,
        options: jwt.SignOptions,
        payload: object = { typ: 'refresh' },
      ) =>
        jwt.sign(payload, secret, {
          algorithm: 'HS256',
          subject: sub,
          jwtid: randomUUID(),
          issuer: 'hamro-pasal-api',
          audience: 'hamro-pasal-refresh',
          expiresIn: 60,
          ...options,
        });

      const candidates = [
        session.access_token,
        signWith(ACCESS_SECRET, {}),
        signWith(REFRESH_SECRET, { audience: 'hamro-pasal-app' }),
        signWith(REFRESH_SECRET, { expiresIn: -1 }),
        signWith(REFRESH_SECRET, {}, {}),
        `${session.refresh_token.slice(0, -2)}xx`,
        'not-a-jwt',
      ];
      const responses = await Promise.all(candidates.map((token) => refresh(token)));

      for (const res of responses) {
        expect(res.status).toBe(401);
        expect(errorOf(res).code).toBe('REFRESH_TOKEN_INVALID');
      }
      // A correctly formed token with the right secret, audience and type still works.
      expect((await refresh(signWith(REFRESH_SECRET, {}))).status).toBe(200);
    });

    it('refuses a refresh token whose account was deleted', async () => {
      const session = await signIn();
      await t.container.db.delete(users).where(eq(users.id, session.user.id));

      const res = await refresh(session.refresh_token);

      expect(res.status).toBe(401);
      expect(errorOf(res).code).toBe('REFRESH_TOKEN_INVALID');
    });

    it('validates the body', async () => {
      const missing = await request(t.app).post('/api/auth/token/refresh').send({});
      const empty = await refresh('');

      expect([missing.status, empty.status]).toEqual([400, 400]);
      expect(errorOf(missing).code).toBe('VALIDATION_FAILED');
    });
  });
});
