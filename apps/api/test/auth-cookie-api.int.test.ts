import { randomInt, randomUUID } from 'node:crypto';

import { users } from '@hamro-pasal/db';
import {
  adminVendorListResponseSchema,
  authTokensResponseSchema,
  cookieAuthTokensResponseSchema,
  sessionRefreshResponseSchema,
  type UserRole,
} from '@hamro-pasal/shared-types';
import { eq } from 'drizzle-orm';
import jwt from 'jsonwebtoken';
import request from 'supertest';

import { verifyAccessToken } from '../src/auth/access-token';
import { verifyRefreshToken } from '../src/auth/refresh-token';
import { createUser } from './support/fixtures';
import {
  ACCESS_SECRET,
  bodyOf,
  buildTestApp,
  errorOf,
  REFRESH_SECRET,
  type TestApp,
} from './support/http';

const COOKIE_NAME = 'hamro_pasal_refresh';
const SEVEN_DAYS_SECONDS = 604_800;

interface SetCookie {
  readonly name: string;
  readonly value: string;
  /** Attribute names in lower case; flags (HttpOnly, Secure) map to ''. */
  readonly attributes: Readonly<Record<string, string>>;
}

/** Every Set-Cookie header of a response, parsed. */
function setCookies(res: { headers: Record<string, unknown> }): SetCookie[] {
  const raw = res.headers['set-cookie'];
  const lines = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
  return lines.map((line) => {
    const [pair = '', ...rest] = String(line).split(';');
    const separator = pair.indexOf('=');
    return {
      name: pair.slice(0, separator).trim(),
      value: pair.slice(separator + 1).trim(),
      attributes: Object.fromEntries(
        rest.map((attribute) => {
          const [key = '', ...value] = attribute.trim().split('=');
          return [key.toLowerCase(), value.join('=')];
        }),
      ),
    };
  });
}

/** Phase 16: the browser's refresh token lives in an HttpOnly cookie (real Express + Redis + PG). */
describe('cookie refresh sessions', () => {
  let t: TestApp;

  beforeAll(() => {
    t = buildTestApp();
  });

  afterAll(async () => {
    await t.container.close();
  });

  const refresh = (cookie?: string) => {
    const call = request(t.app).post('/api/auth/refresh');
    return cookie === undefined ? call : call.set('Cookie', cookie);
  };
  const withToken = (token: string) => `${COOKIE_NAME}=${token}`;

  /** Signs an account of `role` in through the real OTP flow and returns the verify response. */
  async function signIn(role: UserRole | 'NEW') {
    let phone = `+9779${String(randomInt(0, 1_000_000_000)).padStart(9, '0')}`;
    let userId: string | null = null;
    if (role !== 'NEW') {
      userId = await createUser(t.container.db, role);
      const [user] = await t.container.db.select().from(users).where(eq(users.id, userId));
      phone = user?.phone ?? '';
    }
    await request(t.app).post('/api/auth/otp/send').send({ phone });
    const sms = t.sms.sent.filter((message) => message.to === phone).at(-1);
    const code = /\b([0-9]{6})\b/.exec(sms?.text ?? '')?.[1] ?? '';
    const res = await request(t.app).post('/api/auth/otp/verify').send({ phone, code });
    expect(res.status).toBe(200);
    return { res, phone, userId };
  }

  /** A signed-in Super Admin: the user id, phone and the refresh cookie the browser now holds. */
  async function adminSession() {
    const { res, phone, userId } = await signIn('SUPER_ADMIN');
    const [cookie] = setCookies(res);
    if (cookie === undefined || userId === null) throw new Error('No refresh cookie was set');
    return { userId, phone, token: cookie.value, cookie: withToken(cookie.value) };
  }

  /** A refresh JWT for `sub`, correct unless `options`/`payload` break it. */
  const signRefresh = (
    sub: string,
    secret: string = REFRESH_SECRET,
    options: jwt.SignOptions = {},
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

  function expectCleared(res: { headers: Record<string, unknown> }): void {
    const cookies = setCookies(res);
    expect(cookies).toHaveLength(1);
    expect(cookies[0]).toMatchObject({ name: COOKIE_NAME, value: '' });
    const attributes = cookies[0]?.attributes ?? {};
    // Same attributes as when it was set, or the browser would keep the original.
    expect(attributes).toMatchObject({ path: '/api/auth', samesite: 'Strict' });
    expect(attributes).toHaveProperty('httponly');
    expect(attributes).toHaveProperty('secure');
    expect(new Date(attributes.expires ?? '').getTime()).toBe(0);
  }

  describe('POST /api/auth/otp/verify', () => {
    it('gives a Super Admin the refresh token only as an HttpOnly, Secure, SameSite=Strict cookie', async () => {
      const { res, userId } = await signIn('SUPER_ADMIN');

      const cookies = setCookies(res);
      expect(cookies).toHaveLength(1);
      const cookie = cookies[0];
      expect(cookie?.name).toBe(COOKIE_NAME);
      expect(Object.keys(cookie?.attributes ?? {}).sort()).toEqual([
        'expires',
        'httponly',
        'max-age',
        'path',
        'samesite',
        'secure',
      ]);
      expect(cookie?.attributes).toMatchObject({
        samesite: 'Strict',
        path: '/api/auth',
        'max-age': String(SEVEN_DAYS_SECONDS),
      });
      // The cookie carries a real 7-day refresh token for this admin.
      expect(verifyRefreshToken(cookie?.value ?? '', REFRESH_SECRET).userId).toBe(userId);
      const decoded = jwt.decode(cookie?.value ?? '') as { exp: number; iat: number };
      expect(decoded.exp - decoded.iat).toBe(SEVEN_DAYS_SECONDS);

      // The body is strict: an access token, and no refresh token anywhere a script could read it.
      expect(res.headers['cache-control']).toBe('no-store');
      const body = bodyOf(cookieAuthTokensResponseSchema, res);
      expect(body).toMatchObject({
        token_type: 'Bearer',
        access_token_expires_in: 900,
        refresh_token_expires_in: SEVEN_DAYS_SECONDS,
        user: { id: userId, role: 'SUPER_ADMIN' },
      });
      expect(JSON.stringify(res.body)).not.toContain(cookie?.value);
      expect(verifyAccessToken(body.access_token, ACCESS_SECRET)).toEqual({
        userId,
        role: 'SUPER_ADMIN',
      });
    });

    it.each(['NEW', 'CUSTOMER', 'VENDOR', 'DRIVER'] as const)(
      'keeps the refresh token in the body and sets no cookie for a %s account',
      async (role) => {
        const { res } = await signIn(role);

        expect(setCookies(res)).toEqual([]);
        const body = bodyOf(authTokensResponseSchema, res);
        expect(verifyRefreshToken(body.refresh_token, REFRESH_SECRET).userId).toBe(body.user.id);
      },
    );
  });

  describe('POST /api/auth/refresh', () => {
    it('issues a fresh 15-minute access token and the account for a valid cookie', async () => {
      const admin = await adminSession();

      const res = await refresh(admin.cookie);

      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
      const body = bodyOf(sessionRefreshResponseSchema, res);
      expect(body).toMatchObject({
        token_type: 'Bearer',
        access_token_expires_in: 900,
        user: { id: admin.userId, role: 'SUPER_ADMIN', first_name: 'Test', phone: admin.phone },
      });
      expect(verifyAccessToken(body.access_token, ACCESS_SECRET)).toEqual({
        userId: admin.userId,
        role: 'SUPER_ADMIN',
      });
      const decoded = jwt.decode(body.access_token) as { exp: number; iat: number };
      expect(decoded.exp - decoded.iat).toBe(900);
      // The new token opens the admin routes.
      const vendors = await request(t.app)
        .get('/api/admin/vendors')
        .set('authorization', `Bearer ${body.access_token}`);
      expect(vendors.status).toBe(200);
      bodyOf(adminVendorListResponseSchema, vendors);
      // The refresh token never appears in a body, and the cookie is not rotated or re-sent.
      expect(JSON.stringify(res.body)).not.toContain(admin.token);
      expect(setCookies(res)).toEqual([]);
      expect((await refresh(admin.cookie)).status).toBe(200);
    });

    it('finds its cookie among others', async () => {
      const admin = await adminSession();

      const res = await refresh(`theme=dark; ${admin.cookie}; other=1`);

      expect(res.status).toBe(200);
      expect(bodyOf(sessionRefreshResponseSchema, res).user.id).toBe(admin.userId);
    });

    it('refuses a request without the cookie, even with a valid token in the body or a header', async () => {
      const admin = await adminSession();

      const none = await refresh();
      const inBody = await request(t.app)
        .post('/api/auth/refresh')
        .send({ refresh_token: admin.token });
      const inHeader = await request(t.app)
        .post('/api/auth/refresh')
        .set('authorization', `Bearer ${admin.token}`);
      const otherCookie = await refresh(`session=${admin.token}`);
      const empty = await refresh(`${COOKIE_NAME}=`);

      for (const res of [none, inBody, inHeader, otherCookie, empty]) {
        expect(res.status).toBe(401);
        expect(errorOf(res).code).toBe('REFRESH_TOKEN_INVALID');
        expect(JSON.stringify(res.body)).not.toContain('access_token');
      }
    });

    it('refuses an expired, forged, wrong-audience, mistyped or tampered cookie and clears it', async () => {
      const admin = await adminSession();
      const accessToken = bodyOf(sessionRefreshResponseSchema, await refresh(admin.cookie));

      const candidates = [
        signRefresh(admin.userId, REFRESH_SECRET, { expiresIn: -1 }),
        signRefresh(admin.userId, ACCESS_SECRET),
        signRefresh(admin.userId, REFRESH_SECRET, { audience: 'hamro-pasal-app' }),
        signRefresh(admin.userId, REFRESH_SECRET, {}, {}),
        accessToken.access_token,
        `${admin.token.slice(0, -2)}xx`,
        'not-a-jwt',
      ];
      const responses = await Promise.all(candidates.map((token) => refresh(withToken(token))));

      for (const res of responses) {
        expect(res.status).toBe(401);
        expect(errorOf(res).code).toBe('REFRESH_TOKEN_INVALID');
        expectCleared(res);
      }
      // A correctly formed token with the right secret, audience and type still works.
      expect((await refresh(withToken(signRefresh(admin.userId)))).status).toBe(200);
    });

    it('refuses the cookie of a deleted account', async () => {
      const admin = await adminSession();
      await t.container.db.delete(users).where(eq(users.id, admin.userId));

      const res = await refresh(admin.cookie);

      expect(res.status).toBe(401);
      expect(errorOf(res).code).toBe('REFRESH_TOKEN_INVALID');
      expectCleared(res);
    });

    it('ends the session of an admin who was demoted (the role is read from the database)', async () => {
      const admin = await adminSession();
      await t.container.db
        .update(users)
        .set({ role: 'CUSTOMER' })
        .where(eq(users.id, admin.userId));

      const res = await refresh(admin.cookie);

      expect(res.status).toBe(401);
      expect(errorOf(res).code).toBe('REFRESH_TOKEN_INVALID');
      expectCleared(res);
    });

    it("refuses another role's refresh token presented as the cookie", async () => {
      const { res: signedIn } = await signIn('VENDOR');
      const vendor = bodyOf(authTokensResponseSchema, signedIn);

      const res = await refresh(withToken(vendor.refresh_token));

      expect(res.status).toBe(401);
      expect(errorOf(res).code).toBe('REFRESH_TOKEN_INVALID');
    });
  });

  describe('POST /api/auth/logout', () => {
    it('clears the refresh cookie with the attributes it was set with', async () => {
      const admin = await adminSession();

      const res = await request(t.app).post('/api/auth/logout').set('Cookie', admin.cookie);

      expect(res.status).toBe(204);
      expect(res.text).toBe('');
      expect(res.headers['cache-control']).toBe('no-store');
      expectCleared(res);
    });

    it('answers the same without a cookie (a repeated sign-out)', async () => {
      const res = await request(t.app).post('/api/auth/logout');

      expect(res.status).toBe(204);
      expectCleared(res);
    });
  });
});
