import { randomInt } from 'node:crypto';

import { auditLogs, authEvents } from '@hamro-pasal/db';
import {
  adminAuthLogListResponseSchema,
  adminOtpRevealResponseSchema,
} from '@hamro-pasal/shared-types';
import { and, eq } from 'drizzle-orm';
import request from 'supertest';

import { otpKeys } from '../src/auth/otp-store';
import { createUser } from './support/fixtures';
import { bearer, bodyOf, buildTestApp, errorOf, type TestApp } from './support/http';

/**
 * 2026-10-21 (Task 5, "guarded reveal"): the Authentication Logs and the reveal of a live login
 * code, on real Express, Redis and PostgreSQL. One app keeps codes revealable (OTP_ADMIN_REVEAL),
 * the other is the default (hash only).
 */
describe('Authentication Logs', () => {
  let revealing: TestApp;
  let hashOnly: TestApp;
  let admin: string;

  beforeAll(async () => {
    revealing = buildTestApp({ otpAdminReveal: true });
    hashOnly = buildTestApp();
    admin = bearer(await createUser(revealing.container.db, 'SUPER_ADMIN'), 'SUPER_ADMIN');
  });

  afterAll(async () => {
    await revealing.container.close();
    await hashOnly.container.close();
  });

  const freshPhone = () => `+9779${String(randomInt(0, 1_000_000_000)).padStart(9, '0')}`;
  const sendOtp = (t: TestApp, phone: string) =>
    request(t.app).post('/api/auth/otp/send').send({ phone });
  const verify = (t: TestApp, phone: string, code: string) =>
    request(t.app).post('/api/auth/otp/verify').send({ phone, code });
  const codeSentTo = (t: TestApp, phone: string): string =>
    /\b([0-9]{6})\b/.exec(t.sms.sent.filter((m) => m.to === phone).at(-1)?.text ?? '')?.[1] ?? '';
  const logs = (t: TestApp, phone: string, token = admin) =>
    request(t.app).get('/api/admin/auth-logs').query({ phone }).set('authorization', token);
  const reveal = (t: TestApp, body: unknown, token = admin) =>
    request(t.app)
      .post('/api/admin/auth-logs/reveal')
      .set('authorization', token)
      .send(body as object);

  it('logs every send and check, never the code', async () => {
    const phone = freshPhone();
    expect((await sendOtp(revealing, phone)).status).toBe(200);
    const code = codeSentTo(revealing, phone);
    await verify(revealing, phone, code === '000000' ? '111111' : '000000');
    await verify(revealing, phone, code);

    const res = await logs(revealing, phone);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const body = bodyOf(adminAuthLogListResponseSchema, res);
    expect(body.entries.map((e) => e.kind)).toEqual(['OTP_VERIFIED', 'OTP_WRONG', 'OTP_SENT']);
    expect(body.entries[1]?.detail).toBe('4 attempts left');
    expect(JSON.stringify(body)).not.toContain(code);
    const rows = await revealing.container.db
      .select()
      .from(authEvents)
      .where(eq(authEvents.phone, phone));
    expect(JSON.stringify(rows)).not.toContain(code);
  });

  it('reveals a live code with a reason, audited, without using it up', async () => {
    const phone = freshPhone();
    await sendOtp(revealing, phone);
    const sent = codeSentTo(revealing, phone);

    const listed = bodyOf(adminAuthLogListResponseSchema, await logs(revealing, phone));
    expect(listed.reveal_enabled).toBe(true);
    expect(listed.entries).toEqual([
      expect.objectContaining({ kind: 'OTP_SENT', revealable: true }),
    ]);

    const res = await reveal(revealing, { phone, reason: 'SMS late for a caller on the phone' });
    expect(res.status).toBe(200);
    const revealed = bodyOf(adminOtpRevealResponseSchema, res);
    expect(revealed).toMatchObject({ phone, code: sent, attempts_used: 0 });
    expect(revealed.expires_in_seconds).toBeGreaterThan(0);

    const [entry] = await revealing.container.db
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.action, 'LOGIN_CODE_REVEALED'),
          eq(auditLogs.entity_id, listed.entries[0]?.id ?? ''),
        ),
      );
    expect(entry?.after_state).toMatchObject({ reason: 'SMS late for a caller on the phone' });
    expect(JSON.stringify(entry)).not.toContain(sent);
    expect(JSON.stringify(entry)).not.toContain(phone);

    // The customer still signs in with it.
    expect((await verify(revealing, phone, sent)).status).toBe(200);
    expect(
      bodyOf(adminAuthLogListResponseSchema, await logs(revealing, phone)).entries[1],
    ).toMatchObject({
      kind: 'OTP_SENT',
      revealable: false,
    });
    const used = await reveal(revealing, { phone, reason: 'Second look after the login' });
    expect([used.status, errorOf(used).code]).toEqual([404, 'OTP_NOT_LIVE']);
  });

  it('refuses a missing or short reason, and anyone but a Super Admin', async () => {
    const phone = freshPhone();
    await sendOtp(revealing, phone);
    for (const body of [
      { phone },
      { phone, reason: 'short' },
      { phone: '9800000000', reason: 'A long enough reason' },
    ]) {
      expect((await reveal(revealing, body)).status).toBe(400);
    }
    const customer = bearer(await createUser(revealing.container.db));
    expect(
      (await reveal(revealing, { phone, reason: 'A long enough reason' }, customer)).status,
    ).toBe(403);
    expect((await logs(revealing, phone, customer)).status).toBe(403);
    expect((await request(revealing.app).get('/api/admin/auth-logs')).status).toBe(401);
  });

  it('keeps codes unreadable by default: hash only, reveal refused', async () => {
    const phone = freshPhone();
    await sendOtp(hashOnly, phone);
    const fields = await hashOnly.container.redisPool.withConnection((redis) =>
      redis.hgetall(otpKeys.code(phone)),
    );
    expect(Object.keys(fields).sort()).toEqual(['attempts', 'digest']);
    expect(bodyOf(adminAuthLogListResponseSchema, await logs(hashOnly, phone))).toMatchObject({
      reveal_enabled: false,
      entries: [expect.objectContaining({ kind: 'OTP_SENT', revealable: false })],
    });
    const refused = await reveal(hashOnly, { phone, reason: 'SMS late for a caller' });
    expect([refused.status, errorOf(refused).code]).toEqual([403, 'OTP_REVEAL_DISABLED']);
  });
});
