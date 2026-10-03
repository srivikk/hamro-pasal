import { http, HttpResponse } from 'msw';

import { useAuthStore } from '../store/useAuthStore';
import {
  acceptedDelivery,
  delivery,
  DELIVERY_ID,
  deliveryBody,
  deliveryCompleted,
  deliveryList,
  errorBody,
  NEW_ORDER_ID,
  pickedUpDelivery,
} from '../test/api-fixtures';
import {
  apiUrl,
  capture,
  server,
  setupApiTestEnvironment,
  TEST_ACCESS_TOKEN,
  type CapturedRequest,
} from '../test/msw';
import {
  advanceDelivery,
  completeDelivery,
  DELIVERIES_PATH,
  DELIVERY_ROUTE_ERROR_CODES,
  deliveryPath,
  fetchDeliveries,
} from './deliveries';
import { DELIVERY_ERROR_CODES } from './delivery';
import { CLIENT_ERROR_CODES, TOKEN_REFRESH_PATH } from './http';

setupApiTestEnvironment();

describe('GET /api/deliveries', () => {
  it('sends the Bearer token and parses deliveryListResponseSchema', async () => {
    const received: CapturedRequest[] = [];
    server.use(
      http.get(apiUrl(DELIVERIES_PATH), async ({ request }) => {
        received.push(await capture(request));
        return HttpResponse.json(deliveryList([delivery(), pickedUpDelivery()]));
      }),
    );

    const deliveries = await fetchDeliveries();

    expect(received[0]?.method).toBe('GET');
    expect(received[0]?.url.pathname).toBe('/api/deliveries');
    expect(received[0]?.headers.get('authorization')).toBe(`Bearer ${TEST_ACCESS_TOKEN}`);
    expect(deliveries).toEqual([delivery(), pickedUpDelivery()]);
  });

  it.each([
    ["the customer's phone", { order: { ...delivery().order, customer_phone: '+9779800000001' } }],
    ['a rider id', { rider_id: '0b0e6c1e-2b7a-4c39-9e54-0a1b2c3d4e5f' }],
    ['a doorstep code', { handoff_otp: '1234' }],
    ['a finished delivery', { state: 'DELIVERED' }],
  ])('rejects a body that carries %s', async (_name, extra) => {
    server.use(
      http.get(apiUrl(DELIVERIES_PATH), () =>
        HttpResponse.json({ deliveries: [{ ...delivery(), ...extra }] }),
      ),
    );

    await expect(fetchDeliveries()).rejects.toMatchObject({
      code: CLIENT_ERROR_CODES.badResponse,
    });
  });
});

describe('POST /api/deliveries/:id/accept and /pickup', () => {
  it.each([
    ['accept', acceptedDelivery()],
    ['pickup', pickedUpDelivery()],
  ] as const)('posts %s without a body and returns the delivery', async (step, answer) => {
    const received: CapturedRequest[] = [];
    server.use(
      http.post(apiUrl(deliveryPath(DELIVERY_ID, step)), async ({ request }) => {
        received.push(await capture(request));
        return HttpResponse.json(deliveryBody(answer));
      }),
    );

    const result = await advanceDelivery(DELIVERY_ID, step);

    expect(received[0]?.url.pathname).toBe(`/api/deliveries/${DELIVERY_ID}/${step}`);
    expect(received[0]?.headers.get('authorization')).toBe(`Bearer ${TEST_ACCESS_TOKEN}`);
    expect(received[0]?.body).toBeUndefined();
    expect(result).toEqual(answer);
  });

  it('surfaces 409 DELIVERY_ALREADY_ASSIGNED', async () => {
    server.use(
      http.post(apiUrl(deliveryPath(DELIVERY_ID, 'accept')), () =>
        HttpResponse.json(errorBody('DELIVERY_ALREADY_ASSIGNED'), { status: 409 }),
      ),
    );

    await expect(advanceDelivery(DELIVERY_ID, 'accept')).rejects.toMatchObject({
      status: 409,
      code: DELIVERY_ROUTE_ERROR_CODES.alreadyAssigned,
    });
  });
});

describe('POST /api/deliveries/:id/complete', () => {
  it('posts exactly { delivery_otp } and parses deliveryConfirmedResponseSchema', async () => {
    const received: CapturedRequest[] = [];
    server.use(
      http.post(apiUrl(deliveryPath(DELIVERY_ID, 'complete')), async ({ request }) => {
        received.push(await capture(request));
        return HttpResponse.json(deliveryCompleted(NEW_ORDER_ID));
      }),
    );

    const result = await completeDelivery(DELIVERY_ID, '0421');

    expect(received[0]?.url.pathname).toBe(`/api/deliveries/${DELIVERY_ID}/complete`);
    expect(received[0]?.headers.get('authorization')).toBe(`Bearer ${TEST_ACCESS_TOKEN}`);
    expect(received[0]?.body).toEqual({ delivery_otp: '0421' });
    expect(result).toEqual(deliveryCompleted(NEW_ORDER_ID));
  });

  it.each(['123', '12345', '12a4', '१२३४', ''])(
    'refuses %p on the device without sending anything',
    async (code) => {
      let requests = 0;
      server.use(
        http.post(apiUrl(deliveryPath(DELIVERY_ID, 'complete')), () => {
          requests += 1;
          return HttpResponse.json(deliveryCompleted(NEW_ORDER_ID));
        }),
      );

      await expect(completeDelivery(DELIVERY_ID, code)).rejects.toMatchObject({
        code: DELIVERY_ERROR_CODES.malformedOtp,
      });
      expect(requests).toBe(0);
    },
  );

  it('surfaces 401 INVALID_OTP as is: no token refresh, no replay (a replay is another guess)', async () => {
    useAuthStore.getState().setSession({ accessToken: TEST_ACCESS_TOKEN, refreshToken: 'r.jwt' });
    let completions = 0;
    let refreshes = 0;
    server.use(
      http.post(apiUrl(deliveryPath(DELIVERY_ID, 'complete')), () => {
        completions += 1;
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

    await expect(completeDelivery(DELIVERY_ID, '0000')).rejects.toMatchObject({
      status: 401,
      code: DELIVERY_ERROR_CODES.invalidOtp,
      details: { attempts_remaining: 4 },
    });
    expect(completions).toBe(1);
    expect(refreshes).toBe(0);
    expect(useAuthStore.getState().accessToken).toBe(TEST_ACCESS_TOKEN);
  });

  it('surfaces the lockout with its retry time', async () => {
    server.use(
      http.post(apiUrl(deliveryPath(DELIVERY_ID, 'complete')), () =>
        HttpResponse.json(errorBody('DELIVERY_OTP_LOCKED', { retry_after_seconds: 900 }), {
          status: 429,
        }),
      ),
    );

    await expect(completeDelivery(DELIVERY_ID, '1234')).rejects.toMatchObject({
      status: 429,
      code: DELIVERY_ERROR_CODES.locked,
      details: { retry_after_seconds: 900 },
    });
  });
});
