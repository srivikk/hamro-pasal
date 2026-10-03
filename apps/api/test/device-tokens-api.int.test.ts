import { randomUUID } from 'node:crypto';

import { deviceTokens, users } from '@hamro-pasal/db';
import { deviceTokenRegisterResponseSchema } from '@hamro-pasal/shared-types';
import { eq } from 'drizzle-orm';
import request from 'supertest';

import { createUser } from './support/fixtures';
import { bearer, bodyOf, buildTestApp, errorOf, type TestApp } from './support/http';

/**
 * Phase 20: POST /api/notifications/device-token on real PostgreSQL. The token is the device's
 * Expo push token; the account is the access token's subject.
 */
describe('device tokens API', () => {
  let t: TestApp;

  beforeAll(() => {
    t = buildTestApp();
  });

  afterAll(async () => {
    await t.container.close();
  });

  const db = () => t.container.db;
  const pushToken = () => `ExponentPushToken[${randomUUID().replaceAll('-', '')}]`;

  function register(
    userId: string,
    body: Record<string, unknown>,
    role: 'CUSTOMER' | 'VENDOR' | 'DRIVER' | 'SUPER_ADMIN' = 'CUSTOMER',
  ) {
    return request(t.app)
      .post('/api/notifications/device-token')
      .set('authorization', bearer(userId, role))
      .send(body);
  }

  function rowsOfToken(token: string) {
    return db().select().from(deviceTokens).where(eq(deviceTokens.token, token));
  }

  it('stores the token for the caller and answers with the contract', async () => {
    const userId = await createUser(db());
    const token = pushToken();

    const res = await register(userId, { token, platform: 'ANDROID' });

    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const body = bodyOf(deviceTokenRegisterResponseSchema, res);
    expect(body.device_token).toMatchObject({ token, platform: 'ANDROID' });
    const rows = await rowsOfToken(token);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ user_id: userId, token, platform: 'ANDROID' });
    expect(rows[0]?.updated_at.toISOString()).toBe(body.device_token.updated_at);
  });

  it.each(['VENDOR', 'DRIVER', 'SUPER_ADMIN'] as const)('accepts a %s too', async (role) => {
    const userId = await createUser(db(), role);
    const token = pushToken();

    const res = await register(userId, { token, platform: 'IOS' }, role);

    expect(res.status).toBe(200);
    expect(await rowsOfToken(token)).toMatchObject([{ user_id: userId, platform: 'IOS' }]);
  });

  it('keeps one row when the same device registers again, and refreshes updated_at', async () => {
    const userId = await createUser(db());
    const token = pushToken();
    const first = bodyOf(
      deviceTokenRegisterResponseSchema,
      await register(userId, { token, platform: 'ANDROID' }),
    );
    const [before] = await rowsOfToken(token);

    const res = await register(userId, { token, platform: 'ANDROID' });

    expect(res.status).toBe(200);
    const rows = await rowsOfToken(token);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(before?.id);
    expect(rows[0]?.created_at).toEqual(before?.created_at);
    expect(
      Date.parse(bodyOf(deviceTokenRegisterResponseSchema, res).device_token.updated_at),
    ).toBeGreaterThanOrEqual(Date.parse(first.device_token.updated_at));
  });

  it('moves a device to the account that signed in on it last', async () => {
    const firstUser = await createUser(db());
    const secondUser = await createUser(db(), 'VENDOR');
    const token = pushToken();
    await register(firstUser, { token, platform: 'ANDROID' });

    const res = await register(secondUser, { token, platform: 'ANDROID' }, 'VENDOR');

    expect(res.status).toBe(200);
    expect(await rowsOfToken(token)).toMatchObject([{ user_id: secondUser }]);
    expect(
      await db().select().from(deviceTokens).where(eq(deviceTokens.user_id, firstUser)),
    ).toEqual([]);
  });

  it('keeps every device of one account', async () => {
    const userId = await createUser(db());
    const phone = pushToken();
    const tablet = pushToken();

    await register(userId, { token: phone, platform: 'ANDROID' });
    await register(userId, { token: tablet, platform: 'IOS' });

    const rows = await db().select().from(deviceTokens).where(eq(deviceTokens.user_id, userId));
    expect(rows.map((row) => row.token).sort()).toEqual([phone, tablet].sort());
  });

  it('stores one row when a device registers five times at once', async () => {
    const userId = await createUser(db());
    const token = pushToken();

    const results = await Promise.all(
      Array.from({ length: 5 }, () => register(userId, { token, platform: 'ANDROID' })),
    );

    expect(results.map((res) => res.status)).toEqual([200, 200, 200, 200, 200]);
    expect(await rowsOfToken(token)).toHaveLength(1);
  });

  it.each([
    ['a token that is not an Expo push token', { token: 'fcm:APA91bHun4', platform: 'ANDROID' }],
    ['an empty token', { token: '', platform: 'ANDROID' }],
    ['an unknown platform', { token: 'ExponentPushToken[abc]', platform: 'WEB' }],
    ['no platform', { token: 'ExponentPushToken[abc]' }],
    [
      'a user id in the body',
      { token: 'ExponentPushToken[abc]', platform: 'ANDROID', user_id: randomUUID() },
    ],
  ])('refuses %s with 400 and stores nothing', async (_name, body) => {
    const userId = await createUser(db());

    const res = await register(userId, body);

    expect(res.status).toBe(400);
    expect(errorOf(res).code).toBe('VALIDATION_FAILED');
    expect(await db().select().from(deviceTokens).where(eq(deviceTokens.user_id, userId))).toEqual(
      [],
    );
  });

  it('requires an access token', async () => {
    const res = await request(t.app)
      .post('/api/notifications/device-token')
      .send({ token: pushToken(), platform: 'ANDROID' });

    expect(res.status).toBe(401);
    expect(errorOf(res).code).toBe('UNAUTHENTICATED');
  });

  it('answers 401 for a token whose account was deleted, and stores nothing', async () => {
    const token = pushToken();

    const res = await register(randomUUID(), { token, platform: 'ANDROID' });

    expect(res.status).toBe(401);
    expect(errorOf(res).code).toBe('UNAUTHENTICATED');
    expect(await rowsOfToken(token)).toEqual([]);
  });

  it('deletes the tokens with their account', async () => {
    const userId = await createUser(db());
    const token = pushToken();
    await register(userId, { token, platform: 'ANDROID' });

    await db().delete(users).where(eq(users.id, userId));

    expect(await rowsOfToken(token)).toEqual([]);
  });

  it('refuses a malformed token and an unknown platform in the database too', async () => {
    const userId = await createUser(db());

    await expect(
      db().insert(deviceTokens).values({ user_id: userId, token: 'not-a-token', platform: 'IOS' }),
    ).rejects.toThrow();
    await expect(
      db()
        .insert(deviceTokens)
        // The column type allows only ANDROID | IOS; the CHECK is what a raw client would hit.
        .values({ user_id: userId, token: pushToken(), platform: 'WEB' as 'IOS' }),
    ).rejects.toThrow();
  });
});
