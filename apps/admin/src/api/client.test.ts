import {
  adminVendorListResponseSchema,
  otpSendResponseSchema,
  type AuthUser,
} from '@hamro-pasal/shared-types';

import { createSessionStore } from '../auth/session-store';
import { ApiError, createApiClient, type FetchLike } from './client';

interface Call {
  readonly url: string;
  readonly method: string | undefined;
  readonly authorization: string | null;
  readonly body: unknown;
}

const VENDORS = { vendors: [], suspension_limit_npr: -2000 };
const ADMIN: AuthUser = {
  id: '5b9c5f8e-3a51-4b8e-9f45-0f5c1d2e3a4b',
  role: 'SUPER_ADMIN',
  first_name: null,
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function unauthenticated(): Response {
  return json({ error: { code: 'UNAUTHENTICATED', message: 'Invalid or expired token' } }, 401);
}

/** A fake API: `route` answers each call; every call is recorded. */
function setup(route: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetch: FetchLike = (url, init) => {
    const headers = new Headers(init.headers);
    const call = {
      url,
      method: init.method,
      authorization: headers.get('authorization'),
      body: typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
    };
    calls.push(call);
    return Promise.resolve(route(call));
  };
  const session = createSessionStore();
  session.getState().setSession({
    phone: '+9779800000099',
    user: ADMIN,
    accessToken: 'access-1',
    refreshToken: 'refresh-1',
  });
  const client = createApiClient({ baseUrl: 'http://api.test', fetch, session });
  const listVendors = () =>
    client.request({
      method: 'GET',
      path: '/api/admin/vendors',
      schema: adminVendorListResponseSchema,
    });
  return { calls, session, client, listVendors };
}

describe('createApiClient', () => {
  it('sends the bearer token and returns the contract-checked body', async () => {
    const { calls, listVendors } = setup(() => json(VENDORS));

    await expect(listVendors()).resolves.toEqual(VENDORS);
    expect(calls).toEqual([
      {
        url: 'http://api.test/api/admin/vendors',
        method: 'GET',
        authorization: 'Bearer access-1',
        body: undefined,
      },
    ]);
  });

  it('builds the query string and skips undefined values', async () => {
    const { calls, client } = setup(() => json(VENDORS));

    await client.request({
      method: 'GET',
      path: '/api/admin/vendors',
      schema: adminVendorListResponseSchema,
      query: { status: 'PENDING', cursor: undefined, q: 'a b&c' },
    });

    expect(calls[0]?.url).toBe('http://api.test/api/admin/vendors?status=PENDING&q=a%20b%26c');
  });

  it('turns the error envelope into an ApiError with code and details', async () => {
    const { listVendors } = setup(() =>
      json({ error: { code: 'FORBIDDEN', message: 'no', details: { role: 'VENDOR' } } }, 403),
    );

    await expect(listVendors()).rejects.toMatchObject({
      status: 403,
      code: 'FORBIDDEN',
      details: { role: 'VENDOR' },
    });
  });

  it('reports a body that breaks the contract as UNEXPECTED_RESPONSE', async () => {
    const { listVendors } = setup(() => json({ vendors: 'nope' }));

    await expect(listVendors()).rejects.toMatchObject({ code: 'UNEXPECTED_RESPONSE' });
  });

  it('reports a failed connection as NETWORK_ERROR', async () => {
    const { listVendors } = setup(() => Promise.reject(new TypeError('Failed to fetch')));

    await expect(listVendors()).rejects.toMatchObject({ status: 0, code: 'NETWORK_ERROR' });
  });

  it('refuses to call without a session', async () => {
    const { calls, session, listVendors } = setup(() => json(VENDORS));
    session.getState().clear();

    await expect(listVendors()).rejects.toMatchObject({ code: 'NOT_SIGNED_IN' });
    expect(calls).toEqual([]);
  });

  it('renews an expired access token once and replays the request', async () => {
    const { calls, session, listVendors } = setup((call) => {
      if (call.url.endsWith('/api/auth/token/refresh')) {
        return json({
          token_type: 'Bearer',
          access_token: 'access-2',
          access_token_expires_in: 900,
        });
      }
      return call.authorization === 'Bearer access-2' ? json(VENDORS) : unauthenticated();
    });

    await expect(listVendors()).resolves.toEqual(VENDORS);
    expect(
      calls.map((call) => [call.url.replace('http://api.test', ''), call.authorization]),
    ).toEqual([
      ['/api/admin/vendors', 'Bearer access-1'],
      ['/api/auth/token/refresh', null],
      ['/api/admin/vendors', 'Bearer access-2'],
    ]);
    expect(calls[1]?.body).toEqual({ refresh_token: 'refresh-1' });
    expect(session.getState().session?.accessToken).toBe('access-2');
  });

  it('makes one refresh call for a burst of expired requests', async () => {
    let refreshes = 0;
    const { listVendors } = setup(async (call) => {
      if (call.url.endsWith('/api/auth/token/refresh')) {
        refreshes += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
        return json({
          token_type: 'Bearer',
          access_token: 'access-2',
          access_token_expires_in: 900,
        });
      }
      return call.authorization === 'Bearer access-2' ? json(VENDORS) : unauthenticated();
    });

    await Promise.all([listVendors(), listVendors(), listVendors()]);

    expect(refreshes).toBe(1);
  });

  it('signs out when the refresh token is refused, and surfaces the original 401', async () => {
    const { session, listVendors } = setup((call) =>
      call.url.endsWith('/api/auth/token/refresh')
        ? json({ error: { code: 'REFRESH_TOKEN_INVALID', message: 'expired' } }, 401)
        : unauthenticated(),
    );

    await expect(listVendors()).rejects.toMatchObject({ status: 401, code: 'UNAUTHENTICATED' });
    expect(session.getState().session).toBeNull();
  });

  it('keeps the session when the refresh fails for network reasons', async () => {
    const { session, listVendors } = setup((call) =>
      call.url.endsWith('/api/auth/token/refresh')
        ? json({ error: { code: 'INTERNAL_SERVER_ERROR', message: 'down' } }, 503)
        : unauthenticated(),
    );

    await expect(listVendors()).rejects.toMatchObject({ status: 503 });
    expect(session.getState().session?.refreshToken).toBe('refresh-1');
  });

  it('does not loop when the renewed token is refused too', async () => {
    const { calls, listVendors } = setup((call) =>
      call.url.endsWith('/api/auth/token/refresh')
        ? json({ token_type: 'Bearer', access_token: 'access-2', access_token_expires_in: 900 })
        : unauthenticated(),
    );

    await expect(listVendors()).rejects.toBeInstanceOf(ApiError);
    expect(calls).toHaveLength(3);
  });

  it('does not refresh for a 401 that is not about the token', async () => {
    const { calls, listVendors } = setup(() =>
      json({ error: { code: 'OTP_INVALID', message: 'wrong' } }, 401),
    );

    await expect(listVendors()).rejects.toMatchObject({ code: 'OTP_INVALID' });
    expect(calls).toHaveLength(1);
  });

  it('never revives a session that was signed out while the refresh was running', async () => {
    let signOut = (): void => undefined;
    const { session, listVendors } = setup((call) => {
      if (call.url.endsWith('/api/auth/token/refresh')) {
        signOut();
        return json({
          token_type: 'Bearer',
          access_token: 'access-2',
          access_token_expires_in: 900,
        });
      }
      return unauthenticated();
    });
    signOut = () => {
      session.getState().clear();
    };

    await expect(listVendors()).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    expect(session.getState().session).toBeNull();
  });

  it('sends public requests without a token', async () => {
    const { calls, client } = setup(() =>
      json({ phone: '+9779800000099', expires_in_seconds: 120, resend_after_seconds: 60 }),
    );

    await client.publicRequest({
      method: 'POST',
      path: '/api/auth/otp/send',
      schema: otpSendResponseSchema,
      body: { phone: '+9779800000099' },
    });

    expect(calls[0]).toMatchObject({ authorization: null, body: { phone: '+9779800000099' } });
  });
});
