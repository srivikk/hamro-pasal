import express, { type Request } from 'express';
import request from 'supertest';

import {
  clearRefreshCookie,
  readRefreshCookie,
  REFRESH_COOKIE,
  setRefreshCookie,
} from './refresh-cookie';

const read = (cookie?: string) =>
  readRefreshCookie({ headers: cookie === undefined ? {} : { cookie } } as Request);

function firstSetCookie(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers['set-cookie'];
  return String(Array.isArray(raw) ? raw[0] : raw);
}

describe('refresh cookie', () => {
  const app = express();
  app.post('/set', (_req, res) => {
    setRefreshCookie(res, 'a.b-c_d.e');
    res.end();
  });
  app.post('/clear', (_req, res) => {
    clearRefreshCookie(res);
    res.end();
  });

  it('lives for the refresh token lifetime, on the auth endpoints only', () => {
    expect(REFRESH_COOKIE).toEqual({
      name: 'hamro_pasal_refresh',
      path: '/api/auth',
      maxAgeSeconds: 604_800,
    });
  });

  it('is set HttpOnly, Secure and SameSite=Strict, with the token unchanged', async () => {
    const line = firstSetCookie(await request(app).post('/set'));

    expect(line.startsWith('hamro_pasal_refresh=a.b-c_d.e; ')).toBe(true);
    const attributes = line.split('; ').slice(1);
    expect(attributes).toEqual(
      expect.arrayContaining([
        'Max-Age=604800',
        'Path=/api/auth',
        'HttpOnly',
        'Secure',
        'SameSite=Strict',
      ]),
    );
    // No Domain: the cookie stays on the exact host that set it.
    expect(attributes.some((attribute) => attribute.startsWith('Domain'))).toBe(false);
  });

  it('is cleared with the same attributes and an expiry in the past', async () => {
    const line = firstSetCookie(await request(app).post('/clear'));

    expect(line.split('; ')).toEqual([
      'hamro_pasal_refresh=',
      'Path=/api/auth',
      'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
      'HttpOnly',
      'Secure',
      'SameSite=Strict',
    ]);
  });

  it('is read from the Cookie header by exact name', () => {
    expect(read('hamro_pasal_refresh=a.b.c')).toBe('a.b.c');
    expect(read('theme=dark; hamro_pasal_refresh=a.b.c; other=1')).toBe('a.b.c');
    expect(read('theme=dark;hamro_pasal_refresh=a.b.c')).toBe('a.b.c');
    expect(read('hamro_pasal_refresh=first; hamro_pasal_refresh=second')).toBe('first');
  });

  it('is absent without the header, under another name, or when empty', () => {
    expect(read()).toBeNull();
    expect(read('')).toBeNull();
    expect(read('session=a.b.c')).toBeNull();
    expect(read('x_hamro_pasal_refresh=a.b.c; hamro_pasal_refresh_2=a.b.c')).toBeNull();
    expect(read('hamro_pasal_refresh=')).toBeNull();
    expect(read('hamro_pasal_refresh')).toBeNull();
  });
});
