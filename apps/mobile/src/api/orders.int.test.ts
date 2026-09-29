import { http, HttpResponse } from 'msw';

import {
  cancelResponse,
  errorBody,
  ORDER_ID,
  orderDetailResponse,
  orderSnapshot,
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
  CANCELLATION_WINDOW_EXPIRED,
  cancelOrder,
  cancelOrderPath,
  fetchOrder,
  orderPath,
} from './orders';

setupApiTestEnvironment();

describe('GET /api/orders/:id', () => {
  it('sends the Bearer token and parses orderDetailResponseSchema', async () => {
    const received: CapturedRequest[] = [];
    server.use(
      http.get(apiUrl(orderPath(ORDER_ID)), async ({ request }) => {
        received.push(await capture(request));
        return HttpResponse.json(
          orderDetailResponse({ state: 'DELIVERED', delivered_at: '2026-09-29T11:00:00.000Z' }),
        );
      }),
    );

    const order = await fetchOrder(ORDER_ID);

    expect(received[0]?.method).toBe('GET');
    expect(received[0]?.url.pathname).toBe(`/api/orders/${ORDER_ID}`);
    expect(received[0]?.headers.get('authorization')).toBe(`Bearer ${TEST_ACCESS_TOKEN}`);
    expect(order).toEqual(
      orderSnapshot({ state: 'DELIVERED', delivered_at: '2026-09-29T11:00:00.000Z' }),
    );
  });

  it('rejects a body that exposes the OTP hash', async () => {
    server.use(
      http.get(apiUrl(orderPath(ORDER_ID)), () =>
        HttpResponse.json({ order: { ...orderSnapshot(), delivery_otp: '$2b$10$abc' } }),
      ),
    );

    await expect(fetchOrder(ORDER_ID)).rejects.toMatchObject({
      code: CLIENT_ERROR_CODES.badResponse,
    });
  });
});

describe('POST /api/orders/:id/cancel', () => {
  it('posts to the cancel path with the Bearer token and parses cancelOrderResponseSchema', async () => {
    const received: CapturedRequest[] = [];
    server.use(
      http.post(apiUrl(cancelOrderPath(ORDER_ID)), async ({ request }) => {
        received.push(await capture(request));
        return HttpResponse.json(cancelResponse(true));
      }),
    );

    const result = await cancelOrder(ORDER_ID);

    expect(received[0]?.method).toBe('POST');
    expect(received[0]?.url.pathname).toBe(`/api/orders/${ORDER_ID}/cancel`);
    expect(received[0]?.headers.get('authorization')).toBe(`Bearer ${TEST_ACCESS_TOKEN}`);
    expect(result).toEqual({ order_id: ORDER_ID, state: 'CANCELED', refund_required: true });
  });

  it('surfaces 422 CANCELLATION_WINDOW_EXPIRED as an ApiError', async () => {
    server.use(
      http.post(apiUrl(cancelOrderPath(ORDER_ID)), () =>
        HttpResponse.json(errorBody(CANCELLATION_WINDOW_EXPIRED), { status: 422 }),
      ),
    );

    await expect(cancelOrder(ORDER_ID)).rejects.toMatchObject({
      status: 422,
      code: 'CANCELLATION_WINDOW_EXPIRED',
    });
  });
});
