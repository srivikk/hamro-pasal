import { delay, http, HttpResponse } from 'msw';

import { getSecureStorage } from '../storage/secure-mmkv';
import { AUTH_STORE_KEY, useAuthStore } from '../store/useAuthStore';
import { errorBody, ORDER_ID, orderDetailResponse, TEST_PHONE } from '../test/api-fixtures';
import { apiUrl, server, setupApiTestEnvironment } from '../test/msw';
import { OTP_VERIFY_PATH, verifyOtp } from './auth';
import { CLIENT_ERROR_CODES, onSessionExpired, TOKEN_REFRESH_PATH } from './http';
import { fetchOrder, orderPath } from './orders';

setupApiTestEnvironment();

const EXPIRED = 'expired.access.token';
const RENEWED = 'renewed.access.token';
const REFRESH = 'stored.refresh.token';

interface Calls {
  /** Authorization header of every order request, in order. */
  orders: (string | null)[];
  /** refresh_token sent in every refresh request. */
  refreshes: unknown[];
}

/**
 * GET /api/orders/:id accepts only RENEWED; POST /token/refresh answers `refresh()`.
 */
function serve(refresh: () => Response | Promise<Response>): Calls {
  const calls: Calls = { orders: [], refreshes: [] };
  server.use(
    http.get(apiUrl(orderPath(ORDER_ID)), ({ request }) => {
      const authorization = request.headers.get('authorization');
      calls.orders.push(authorization);
      return authorization === `Bearer ${RENEWED}`
        ? HttpResponse.json(orderDetailResponse())
        : HttpResponse.json(errorBody('UNAUTHENTICATED'), { status: 401 });
    }),
    http.post(apiUrl(TOKEN_REFRESH_PATH), async ({ request }) => {
      calls.refreshes.push(((await request.json()) as { refresh_token: unknown }).refresh_token);
      return refresh();
    }),
  );
  return calls;
}

const renewed = () =>
  HttpResponse.json({ token_type: 'Bearer', access_token: RENEWED, access_token_expires_in: 900 });

const persistedAuth = () => getSecureStorage().getString(AUTH_STORE_KEY) ?? '';

beforeEach(() => {
  useAuthStore.getState().setSession({ accessToken: EXPIRED, refreshToken: REFRESH });
});

describe('apiRequest token renewal', () => {
  it('refreshes an expired access token and replays the request transparently', async () => {
    const calls = serve(renewed);

    const order = await fetchOrder(ORDER_ID);

    expect(order.id).toBe(ORDER_ID);
    expect(calls.orders).toEqual([`Bearer ${EXPIRED}`, `Bearer ${RENEWED}`]);
    expect(calls.refreshes).toEqual([REFRESH]);
    expect(useAuthStore.getState()).toMatchObject({ accessToken: RENEWED, refreshToken: REFRESH });
    // The new access token stays in memory only.
    expect(persistedAuth()).toContain(REFRESH);
    expect(persistedAuth()).not.toContain(RENEWED);
  });

  it('pauses concurrent requests behind a single refresh', async () => {
    const calls = serve(async () => {
      await delay(50);
      return renewed();
    });

    const orders = await Promise.all([
      fetchOrder(ORDER_ID),
      fetchOrder(ORDER_ID),
      fetchOrder(ORDER_ID),
    ]);

    expect(orders.map((o) => o.id)).toEqual([ORDER_ID, ORDER_ID, ORDER_ID]);
    expect(calls.refreshes).toHaveLength(1);
    expect(calls.orders.filter((a) => a === `Bearer ${RENEWED}`)).toHaveLength(3);
  });

  it('refreshes first after a relaunch (refresh token stored, no access token in memory)', async () => {
    useAuthStore.setState({ accessToken: null });
    const calls = serve(renewed);

    await fetchOrder(ORDER_ID);

    expect(calls.refreshes).toEqual([REFRESH]);
    expect(calls.orders).toEqual([`Bearer ${RENEWED}`]);
  });

  it('signs out and notifies when the refresh token is refused', async () => {
    const calls = serve(() =>
      HttpResponse.json(errorBody('REFRESH_TOKEN_INVALID'), { status: 401 }),
    );
    const expired = jest.fn();
    const unsubscribe = onSessionExpired(expired);

    await expect(fetchOrder(ORDER_ID)).rejects.toMatchObject({
      status: 401,
      code: 'UNAUTHENTICATED',
    });

    unsubscribe();
    expect(expired).toHaveBeenCalledTimes(1);
    expect(calls.orders).toHaveLength(1);
    expect(useAuthStore.getState()).toMatchObject({ accessToken: null, refreshToken: null });
    expect(persistedAuth()).not.toContain(REFRESH);
  });

  it('keeps the session when the refresh fails for network or server reasons', async () => {
    serve(() => HttpResponse.error());
    await expect(fetchOrder(ORDER_ID)).rejects.toMatchObject({
      code: CLIENT_ERROR_CODES.network,
    });
    expect(useAuthStore.getState().refreshToken).toBe(REFRESH);

    serve(() => HttpResponse.json(errorBody('INTERNAL_SERVER_ERROR'), { status: 503 }));
    await expect(fetchOrder(ORDER_ID)).rejects.toMatchObject({ status: 503 });
    expect(useAuthStore.getState().refreshToken).toBe(REFRESH);
  });

  it('refreshes at most once per request (no loop if the new token is refused too)', async () => {
    const calls = serve(() =>
      HttpResponse.json({
        token_type: 'Bearer',
        access_token: 'also.refused',
        access_token_expires_in: 900,
      }),
    );

    await expect(fetchOrder(ORDER_ID)).rejects.toMatchObject({ status: 401 });

    expect(calls.refreshes).toHaveLength(1);
    expect(calls.orders).toEqual([`Bearer ${EXPIRED}`, 'Bearer also.refused']);
  });

  it('reuses a token another request already renewed instead of refreshing again', async () => {
    const calls: Calls = { orders: [], refreshes: [] };
    server.use(
      http.get(apiUrl(orderPath(ORDER_ID)), ({ request }) => {
        const authorization = request.headers.get('authorization');
        calls.orders.push(authorization);
        if (authorization === `Bearer ${RENEWED}`) return HttpResponse.json(orderDetailResponse());
        // Meanwhile, another request finished a refresh.
        useAuthStore.getState().setAccessToken(RENEWED);
        return HttpResponse.json(errorBody('UNAUTHENTICATED'), { status: 401 });
      }),
      http.post(apiUrl(TOKEN_REFRESH_PATH), () => {
        calls.refreshes.push('unexpected');
        return renewed();
      }),
    );

    await fetchOrder(ORDER_ID);

    expect(calls.refreshes).toEqual([]);
    expect(calls.orders).toEqual([`Bearer ${EXPIRED}`, `Bearer ${RENEWED}`]);
  });

  it('never revives a session that was signed out while the refresh was running', async () => {
    serve(async () => {
      useAuthStore.getState().clearSession();
      await delay(10);
      return renewed();
    });

    await expect(fetchOrder(ORDER_ID)).rejects.toMatchObject({ status: 401 });

    expect(useAuthStore.getState()).toMatchObject({ accessToken: null, refreshToken: null });
  });

  it('does not refresh without a refresh token; the 401 surfaces as is', async () => {
    useAuthStore.setState({ refreshToken: null });
    const calls = serve(renewed);

    await expect(fetchOrder(ORDER_ID)).rejects.toMatchObject({ status: 401 });

    expect(calls.refreshes).toEqual([]);
  });

  it('never refreshes for the sign-in endpoints (a wrong OTP is also a 401)', async () => {
    const calls = serve(renewed);
    server.use(
      http.post(apiUrl(OTP_VERIFY_PATH), () =>
        HttpResponse.json(errorBody('OTP_INVALID', { attempts_remaining: 4 }), { status: 401 }),
      ),
    );

    await expect(verifyOtp(TEST_PHONE, '000000')).rejects.toMatchObject({ code: 'OTP_INVALID' });

    expect(calls.refreshes).toEqual([]);
    expect(useAuthStore.getState().refreshToken).toBe(REFRESH);
  });
});
