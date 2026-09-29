import { randomUUID } from 'node:crypto';

import { lockStatusResponseSchema } from '@hamro-pasal/shared-types';
import jwt from 'jsonwebtoken';
import request from 'supertest';

import { mintDevToken } from '../scripts/mint-dev-token';
import { verifyAccessToken } from '../src/auth/access-token';
import { createUser } from './support/fixtures';
import { ACCESS_SECRET, buildTestApp, errorOf, type TestApp } from './support/http';

describe('mint-dev-token script', () => {
  let t: TestApp;

  beforeAll(() => {
    t = buildTestApp();
  });

  afterAll(async () => {
    await t.container.close();
  });

  async function phoneOf(userId: string): Promise<string> {
    const { rows } = await t.container.db.$client.query<{ phone: string }>(
      'SELECT phone FROM users WHERE id = $1',
      [userId],
    );
    const [row] = rows;
    if (row === undefined) throw new Error('user not found');
    return row.phone;
  }

  it('signs a 15-minute token for the user with that phone', async () => {
    const userId = await createUser(t.container.db, 'CUSTOMER');
    const phone = await phoneOf(userId);

    const minted = await mintDevToken(t.container.db, ACCESS_SECRET, phone);

    expect(verifyAccessToken(minted.token, ACCESS_SECRET)).toEqual({ userId, role: 'CUSTOMER' });
    const claims = jwt.decode(minted.token) as { iat: number; exp: number };
    expect(claims.exp - claims.iat).toBe(15 * 60);
    expect(minted.expiresAt.getTime()).toBe(claims.exp * 1000);
  });

  it('accepts national-format numbers and keeps the user role', async () => {
    const userId = await createUser(t.container.db, 'VENDOR');
    const phone = await phoneOf(userId);

    const minted = await mintDevToken(t.container.db, ACCESS_SECRET, phone.slice(4));

    expect(minted).toMatchObject({ userId, role: 'VENDOR', phone });
  });

  it('produces tokens the real API accepts', async () => {
    const userId = await createUser(t.container.db, 'CUSTOMER');
    const { token } = await mintDevToken(t.container.db, ACCESS_SECRET, await phoneOf(userId));

    const res = await request(t.app)
      .get('/api/cart/lock-status')
      .query({ order_id: randomUUID() })
      .set('authorization', `Bearer ${token}`);

    // Authenticated and authorised: the route itself answers (unknown order), not the auth layer.
    expect(res.status).toBe(404);
    expect(errorOf(res).code).toBe('ORDER_NOT_FOUND');
    expect(lockStatusResponseSchema.safeParse(res.body).success).toBe(false);
  });

  it('explains how to fix an unknown phone and rejects non-Nepal numbers', async () => {
    await expect(mintDevToken(t.container.db, ACCESS_SECRET, '+9779811111110')).rejects.toThrow(
      'pnpm db:seed',
    );
    await expect(mintDevToken(t.container.db, ACCESS_SECRET, '+919812345678')).rejects.toThrow(
      'Not a valid Nepal mobile number',
    );
  });
});
