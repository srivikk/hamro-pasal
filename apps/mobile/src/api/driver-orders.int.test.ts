import { http, HttpResponse } from 'msw';

import { useAuthStore } from '../store/useAuthStore';
import {
  driverDelivered,
  driverOrder,
  driverOrderList,
  errorBody,
  NEW_ORDER_ID,
} from '../test/api-fixtures';
import {
  apiUrl,
  capture,
  server,
  setupApiTestEnvironment,
  TEST_ACCESS_TOKEN,
  type CapturedRequest,
} from '../test/msw';
import { DELIVERY_ERROR_CODES } from './delivery';
import {
  deliverDriverOrder,
  DRIVER_ORDERS_PATH,
  driverDeliverPath,
  fetchDriverOrders,
} from './driver-orders';
import { CLIENT_ERROR_CODES, TOKEN_REFRESH_PATH } from './http';

setupApiTestEnvironment();

describe('GET /api/driver/orders', () => {
  it('sends the Bearer token and parses driverOrderListResponseSchema', async () => {
    const received: CapturedRequest[] = [];
    server.use(
      http.get(apiUrl(DRIVER_ORDERS_PATH), async ({ request }) => {
        received.push(await capture(request));
        return HttpResponse.json(driverOrderList([driverOrder()]));
      }),
    );

    const orders = await fetchDriverOrders();

    expect(received[0]?.method).toBe('GET');
    expect(received[0]?.url.pathname).toBe('/api/driver/orders');
    expect(received[0]?.headers.get('authorization')).toBe(`Bearer ${TEST_ACCESS_TOKEN}`);
    expect(orders).toEqual([driverOrder()]);
  });

  it("rejects a body that would expose the customer's phone", async () => {
    server.use(
      http.get(apiUrl(DRIVER_ORDERS_PATH), () =>
        HttpResponse.json({ orders: [{ ...driverOrder(), customer_phone: '+9779800000001' }] }),
      ),
    );

    await expect(fetchDriverOrders()).rejects.toMatchObject({
      code: CLIENT_ERROR_CODES.badResponse,
    });
  });
});

describe('POST /api/driver/orders/:id/deliver', () => {
  it('posts exactly { delivery_otp } and parses deliveryConfirmedResponseSchema', async () => {
    const received: CapturedRequest[] = [];
    server.use(
      http.post(apiUrl(driverDeliverPath(NEW_ORDER_ID)), async ({ request }) => {
        received.push(await capture(request));
        return HttpResponse.json(driverDelivered(NEW_ORDER_ID));
      }),
    );

    const result = await deliverDriverOrder(NEW_ORDER_ID, '0421');

    expect(received[0]?.url.pathname).toBe(`/api/driver/orders/${NEW_ORDER_ID}/deliver`);
    expect(received[0]?.headers.get('authorization')).toBe(`Bearer ${TEST_ACCESS_TOKEN}`);
    expect(received[0]?.body).toEqual({ delivery_otp: '0421' });
    expect(result).toEqual(driverDelivered(NEW_ORDER_ID));
  });

  it.each(['123', '12345', '12a4', '१२३४', ''])(
    'refuses %p on the device without sending anything',
    async (code) => {
      let requests = 0;
      server.use(
        http.post(apiUrl(driverDeliverPath(NEW_ORDER_ID)), () => {
          requests += 1;
          return HttpResponse.json(driverDelivered(NEW_ORDER_ID));
        }),
      );

      await expect(deliverDriverOrder(NEW_ORDER_ID, code)).rejects.toMatchObject({
        code: DELIVERY_ERROR_CODES.malformedOtp,
      });
      expect(requests).toBe(0);
    },
  );

  it('surfaces 401 INVALID_OTP as is: no token refresh, no replay (a replay is another guess)', async () => {
    useAuthStore.getState().setSession({ accessToken: TEST_ACCESS_TOKEN, refreshToken: 'r.jwt' });
    let deliveries = 0;
    let refreshes = 0;
    server.use(
      http.post(apiUrl(driverDeliverPath(NEW_ORDER_ID)), () => {
        deliveries += 1;
        return HttpResponse.json(errorBody('INVALID_OTP', { attempts_remaining: 4 }), {
          status: 401,
        });
      }),
      http.post(apiUrl(TOKEN_REFRESH_PATH), () => {
        refreshes += 1;
        return HttpResponse.json({
          token_type: 'Bearer',
          access_token: 'renewed',
          access_token_expires_in: 900,
        });
      }),
    );

    await expect(deliverDriverOrder(NEW_ORDER_ID, '0000')).rejects.toMatchObject({
      status: 401,
      code: DELIVERY_ERROR_CODES.invalidOtp,
      details: { attempts_remaining: 4 },
    });
    expect(deliveries).toBe(1);
    expect(refreshes).toBe(0);
    expect(useAuthStore.getState().accessToken).toBe(TEST_ACCESS_TOKEN);
  });

  it('surfaces the lockout with its retry time', async () => {
    server.use(
      http.post(apiUrl(driverDeliverPath(NEW_ORDER_ID)), () =>
        HttpResponse.json(errorBody('DELIVERY_OTP_LOCKED', { retry_after_seconds: 900 }), {
          status: 429,
        }),
      ),
    );

    await expect(deliverDriverOrder(NEW_ORDER_ID, '1234')).rejects.toMatchObject({
      status: 429,
      code: DELIVERY_ERROR_CODES.locked,
      details: { retry_after_seconds: 900 },
    });
  });
});
