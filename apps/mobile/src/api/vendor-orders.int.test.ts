import { http, HttpResponse } from 'msw';

import {
  driverDelivered,
  errorBody,
  NEW_ORDER_ID,
  vendorDecision,
  vendorOrder,
  vendorOrderList,
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
import { CLIENT_ERROR_CODES } from './http';
import {
  CANCELLATION_WINDOW_OPEN,
  decideVendorOrder,
  deliverVendorOrder,
  dispatchVendorOrder,
  fetchVendorOrders,
  VENDOR_ORDERS_PATH,
  vendorOrderDecisionPath,
} from './vendor-orders';

setupApiTestEnvironment();

describe('GET /api/vendors/orders', () => {
  it('sends the Bearer token and parses vendorOrderListResponseSchema', async () => {
    const received: CapturedRequest[] = [];
    server.use(
      http.get(apiUrl(VENDOR_ORDERS_PATH), async ({ request }) => {
        received.push(await capture(request));
        return HttpResponse.json(vendorOrderList([vendorOrder()]));
      }),
    );

    const orders = await fetchVendorOrders();

    expect(received[0]?.method).toBe('GET');
    expect(received[0]?.url.pathname).toBe('/api/vendors/orders');
    expect(received[0]?.headers.get('authorization')).toBe(`Bearer ${TEST_ACCESS_TOKEN}`);
    expect(orders).toEqual([vendorOrder()]);
  });

  it('rejects a body that would expose the customer', async () => {
    server.use(
      http.get(apiUrl(VENDOR_ORDERS_PATH), () =>
        HttpResponse.json({ orders: [{ ...vendorOrder(), customer_phone: '+9779800000001' }] }),
      ),
    );

    await expect(fetchVendorOrders()).rejects.toMatchObject({
      code: CLIENT_ERROR_CODES.badResponse,
    });
  });
});

describe('POST /api/vendors/orders/:id/accept | reject', () => {
  it.each([
    ['accept', 'PREPARING', false],
    ['reject', 'CANCELED', true],
  ] as const)('%s posts to its path and parses the decision', async (decision, state, refund) => {
    const received: CapturedRequest[] = [];
    server.use(
      http.post(apiUrl(vendorOrderDecisionPath(NEW_ORDER_ID, decision)), async ({ request }) => {
        received.push(await capture(request));
        return HttpResponse.json(vendorDecision(NEW_ORDER_ID, state, refund));
      }),
    );

    const result = await decideVendorOrder(NEW_ORDER_ID, decision);

    expect(received[0]?.method).toBe('POST');
    expect(received[0]?.url.pathname).toBe(`/api/vendors/orders/${NEW_ORDER_ID}/${decision}`);
    expect(received[0]?.headers.get('authorization')).toBe(`Bearer ${TEST_ACCESS_TOKEN}`);
    expect(received[0]?.body).toBeUndefined();
    expect(result).toEqual({ order_id: NEW_ORDER_ID, state, refund_required: refund });
  });

  it('surfaces ORDER_STATE_CONFLICT with the state the order moved to', async () => {
    server.use(
      http.post(apiUrl(vendorOrderDecisionPath(NEW_ORDER_ID, 'accept')), () =>
        HttpResponse.json(errorBody('ORDER_STATE_CONFLICT', { state: 'CANCELED' }), {
          status: 409,
        }),
      ),
    );

    await expect(decideVendorOrder(NEW_ORDER_ID, 'accept')).rejects.toMatchObject({
      status: 409,
      code: 'ORDER_STATE_CONFLICT',
      details: { state: 'CANCELED' },
    });
  });
});

describe('POST /api/vendors/orders/:id/dispatch', () => {
  it('posts with no body and parses the dispatch result', async () => {
    const received: CapturedRequest[] = [];
    server.use(
      http.post(apiUrl(vendorOrderDecisionPath(NEW_ORDER_ID, 'dispatch')), async ({ request }) => {
        received.push(await capture(request));
        return HttpResponse.json({ order_id: NEW_ORDER_ID, state: 'OUT_FOR_DELIVERY' });
      }),
    );

    const result = await dispatchVendorOrder(NEW_ORDER_ID);

    expect(received[0]?.url.pathname).toBe(`/api/vendors/orders/${NEW_ORDER_ID}/dispatch`);
    expect(received[0]?.headers.get('authorization')).toBe(`Bearer ${TEST_ACCESS_TOKEN}`);
    expect(received[0]?.body).toBeUndefined();
    expect(result).toEqual({ order_id: NEW_ORDER_ID, state: 'OUT_FOR_DELIVERY' });
  });

  it('surfaces 422 CANCELLATION_WINDOW_OPEN with the seconds left', async () => {
    server.use(
      http.post(apiUrl(vendorOrderDecisionPath(NEW_ORDER_ID, 'dispatch')), () =>
        HttpResponse.json(errorBody(CANCELLATION_WINDOW_OPEN, { retry_after_seconds: 42 }), {
          status: 422,
        }),
      ),
    );

    await expect(dispatchVendorOrder(NEW_ORDER_ID)).rejects.toMatchObject({
      status: 422,
      code: 'CANCELLATION_WINDOW_OPEN',
      details: { retry_after_seconds: 42 },
    });
  });
});

describe('POST /api/vendors/orders/:id/deliver', () => {
  it('posts exactly { delivery_otp } and parses the delivery', async () => {
    const received: CapturedRequest[] = [];
    server.use(
      http.post(apiUrl(vendorOrderDecisionPath(NEW_ORDER_ID, 'deliver')), async ({ request }) => {
        received.push(await capture(request));
        return HttpResponse.json(driverDelivered(NEW_ORDER_ID));
      }),
    );

    const result = await deliverVendorOrder(NEW_ORDER_ID, '0421');

    expect(received[0]?.url.pathname).toBe(`/api/vendors/orders/${NEW_ORDER_ID}/deliver`);
    expect(received[0]?.body).toEqual({ delivery_otp: '0421' });
    expect(result).toEqual(driverDelivered(NEW_ORDER_ID));
  });

  it.each(['123', '12345', '१२३४'])('refuses %p on the device without sending it', async (code) => {
    let requests = 0;
    server.use(
      http.post(apiUrl(vendorOrderDecisionPath(NEW_ORDER_ID, 'deliver')), () => {
        requests += 1;
        return HttpResponse.json(driverDelivered(NEW_ORDER_ID));
      }),
    );

    await expect(deliverVendorOrder(NEW_ORDER_ID, code)).rejects.toMatchObject({
      code: DELIVERY_ERROR_CODES.malformedOtp,
    });
    expect(requests).toBe(0);
  });

  it('surfaces 401 INVALID_OTP once, without a token refresh or a replay', async () => {
    let deliveries = 0;
    server.use(
      http.post(apiUrl(vendorOrderDecisionPath(NEW_ORDER_ID, 'deliver')), () => {
        deliveries += 1;
        return HttpResponse.json(errorBody('INVALID_OTP', { attempts_remaining: 2 }), {
          status: 401,
        });
      }),
    );

    await expect(deliverVendorOrder(NEW_ORDER_ID, '9999')).rejects.toMatchObject({
      status: 401,
      code: DELIVERY_ERROR_CODES.invalidOtp,
    });
    expect(deliveries).toBe(1);
  });
});
