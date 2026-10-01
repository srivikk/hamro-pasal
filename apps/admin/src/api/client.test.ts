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
  readonly credentials: RequestCredentials | undefined;
  readonly body: unknown;
}

const VENDORS = { vendors: [], suspension_limit_npr: -2000 };
const PHONE = '+9779800000099';
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

/** What POST /api/auth/refresh answers for a valid refresh cookie. */
function refreshed(accessToken = 'access-2', user: AuthUser = ADMIN): Response {
  return json({
    token_type: 'Bearer',
    access_token: accessToken,
    access_token_expires_in: 900,
    user: { ...user, phone: PHONE },
  });
}

function refused(): Response {
  return json({ error: { code: 'REFRESH_TOKEN_INVALID', message: 'expired' } }, 401);
}

function unauthenticated(): Response {
  return json({ error: { code: 'UNAUTHENTICATED', message: 'Invalid or expired token' } }, 401);
}

/**
 * A fake API: `route` answers each call; every call is recorded. The refresh cookie is the
 * browser's business: the client never sees it, so the fake needs none.
 */
function setup(
  route: (call: Call) => Response | Promise<Response>,
  options: { readonly signedIn: boolean } = { signedIn: true },
) {
  const calls: Call[] = [];
  const fetch: FetchLike = (url, init) => {
    const headers = new Headers(init.headers);
    const call = {
      url,
      method: init.method,
      authorization: headers.get('authorization'),
      credentials: init.credentials,
      body: typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
    };
    calls.push(call);
    return Promise.resolve(route(call));
  };
  const session = createSessionStore();
  if (options.signedIn) {
    session.getState().setSession({ phone: PHONE, user: ADMIN, accessToken: 'access-1' });
  }
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
        credentials: 'same-origin',
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
      if (call.url.endsWith('/api/auth/refresh')) {
        return refreshed();
      }
      return call.authorization === 'Bearer access-2' ? json(VENDORS) : unauthenticated();
    });

    await expect(listVendors()).resolves.toEqual(VENDORS);
    expect(
      calls.map((call) => [call.url.replace('http://api.test', ''), call.authorization]),
    ).toEqual([
      ['/api/admin/vendors', 'Bearer access-1'],
      ['/api/auth/refresh', null],
      ['/api/admin/vendors', 'Bearer access-2'],
    ]);
    // The refresh token is the HttpOnly cookie: nothing is sent in the body, only credentials.
    expect(calls[1]).toMatchObject({ method: 'POST', body: undefined, credentials: 'same-origin' });
    expect(session.getState().session).toEqual({
      phone: PHONE,
      user: ADMIN,
      accessToken: 'access-2',
    });
  });

  it('makes one refresh call for a burst of expired requests', async () => {
    let refreshes = 0;
    const { listVendors } = setup(async (call) => {
      if (call.url.endsWith('/api/auth/refresh')) {
        refreshes += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
        return refreshed();
      }
      return call.authorization === 'Bearer access-2' ? json(VENDORS) : unauthenticated();
    });

    await Promise.all([listVendors(), listVendors(), listVendors()]);

    expect(refreshes).toBe(1);
  });

  it('signs out when the refresh cookie is refused, and surfaces the original 401', async () => {
    const { session, listVendors } = setup((call) =>
      call.url.endsWith('/api/auth/refresh') ? refused() : unauthenticated(),
    );

    await expect(listVendors()).rejects.toMatchObject({ status: 401, code: 'UNAUTHENTICATED' });
    expect(session.getState().session).toBeNull();
  });

  it('keeps the session when the refresh fails for network reasons', async () => {
    const { session, listVendors } = setup((call) =>
      call.url.endsWith('/api/auth/refresh')
        ? json({ error: { code: 'INTERNAL_SERVER_ERROR', message: 'down' } }, 503)
        : unauthenticated(),
    );

    await expect(listVendors()).rejects.toMatchObject({ status: 503 });
    expect(session.getState().session?.accessToken).toBe('access-1');
  });

  it('does not loop when the renewed token is refused too', async () => {
    const { calls, listVendors } = setup((call) =>
      call.url.endsWith('/api/auth/refresh') ? refreshed() : unauthenticated(),
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
      if (call.url.endsWith('/api/auth/refresh')) {
        signOut();
        return refreshed();
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

describe('restoreSession (the silent refresh on page load)', () => {
  it('signs the admin back in from the refresh cookie alone', async () => {
    const { calls, session, client, listVendors } = setup(
      (call) => (call.url.endsWith('/api/auth/refresh') ? refreshed('access-9') : json(VENDORS)),
      { signedIn: false },
    );

    await expect(client.restoreSession()).resolves.toBe(true);

    expect(calls).toEqual([
      {
        url: 'http://api.test/api/auth/refresh',
        method: 'POST',
        authorization: null,
        credentials: 'same-origin',
        body: undefined,
      },
    ]);
    expect(session.getState().session).toEqual({
      phone: PHONE,
      user: ADMIN,
      accessToken: 'access-9',
    });
    // The restored token is the one later calls carry.
    await listVendors();
    expect(calls[1]?.authorization).toBe('Bearer access-9');
  });

  it('stays signed out when the browser holds no valid cookie', async () => {
    const { session, client } = setup(() => refused(), { signedIn: false });

    await expect(client.restoreSession()).resolves.toBe(false);
    expect(session.getState().session).toBeNull();
  });

  it('rejects, without inventing a session, when the API cannot be reached', async () => {
    const { session, client } = setup(() => Promise.reject(new TypeError('Failed to fetch')), {
      signedIn: false,
    });

    await expect(client.restoreSession()).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
    expect(session.getState().session).toBeNull();
  });

  it('rejects an answer that breaks the contract (no account in it)', async () => {
    const { session, client } = setup(
      () => json({ token_type: 'Bearer', access_token: 'access-9', access_token_expires_in: 900 }),
      { signedIn: false },
    );

    await expect(client.restoreSession()).rejects.toMatchObject({ code: 'UNEXPECTED_RESPONSE' });
    expect(session.getState().session).toBeNull();
  });

  it('makes one call when asked twice at once (React StrictMode mounts twice)', async () => {
    const { calls, client } = setup(
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return refreshed();
      },
      { signedIn: false },
    );

    await expect(Promise.all([client.restoreSession(), client.restoreSession()])).resolves.toEqual([
      true,
      true,
    ]);
    expect(calls).toHaveLength(1);
  });

  it('follows the cookie when it now belongs to another admin (signed in from another tab)', async () => {
    const other: AuthUser = { ...ADMIN, id: '9d1f6f0a-6c1b-4b0e-8a57-3e2d1c0b9a88' };
    const { session, listVendors } = setup((call) => {
      if (call.url.endsWith('/api/auth/refresh')) return refreshed('access-2', other);
      return call.authorization === 'Bearer access-2' ? json(VENDORS) : unauthenticated();
    });

    await listVendors();

    expect(session.getState().session).toMatchObject({ user: other, accessToken: 'access-2' });
  });
});
