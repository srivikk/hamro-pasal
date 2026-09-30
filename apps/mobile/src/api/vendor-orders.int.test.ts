import { http, HttpResponse } from 'msw';

import {
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
import { CLIENT_ERROR_CODES } from './http';
import {
  decideVendorOrder,
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
