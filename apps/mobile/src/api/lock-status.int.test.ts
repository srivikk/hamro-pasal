import { waitFor } from '@testing-library/react-native';
import { http, HttpResponse } from 'msw';

import { useCartStore } from '../store/useCartStore';
import { useCheckoutStore, type CheckoutSession } from '../store/useCheckoutStore';
import {
  errorBody,
  lockStatusResponse,
  NOODLES,
  ORDER_ID,
  RESERVATION_ID,
  THAMEL_VENDOR,
} from '../test/api-fixtures';
import {
  apiUrl,
  capture,
  server,
  TEST_ACCESS_TOKEN,
  setupApiTestEnvironment,
  type CapturedRequest,
} from '../test/msw';
import { renderHookWithProviders } from '../test/render';
import { LOCK_STATUS_PATH, LOCK_STATUS_POLL_INTERVAL_MS, useLockStatus } from './queries';

setupApiTestEnvironment();

const FAST_POLL_MS = 40;

const PENDING_SESSION: CheckoutSession = {
  orderId: ORDER_ID,
  reservationId: RESERVATION_ID,
  expiresAt: '2026-09-29T10:10:00.000Z',
  orderState: 'PENDING_PAYMENT',
  paymentMethod: 'ESEWA',
  totalNpr: 1250,
};

function lockStatusEndpoint(respond: (call: number) => Response) {
  const received: CapturedRequest[] = [];
  server.use(
    http.get(apiUrl(LOCK_STATUS_PATH), async ({ request }) => {
      received.push(await capture(request));
      return respond(received.length);
    }),
  );
  return received;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

beforeEach(() => {
  useCartStore.getState().addItem(THAMEL_VENDOR, NOODLES, 1);
});

describe('useLockStatus → GET /api/cart/lock-status', () => {
  it('polls every 5 seconds by default (SPEC §3)', () => {
    expect(LOCK_STATUS_POLL_INTERVAL_MS).toBe(5000);
  });

  it('does not poll when the store holds no reservation', async () => {
    const received = lockStatusEndpoint(() =>
      HttpResponse.json(lockStatusResponse({ status: 'RELEASED', ttl_ms: 0, expires_at: null })),
    );

    const { unmount } = renderHookWithProviders(() => useLockStatus({ intervalMs: FAST_POLL_MS }));
    await sleep(FAST_POLL_MS * 5);
    unmount();

    expect(received).toHaveLength(0);
  });

  it('does not poll for an order that already left checkout (COD, placed at once)', async () => {
    useCheckoutStore.setState({ session: { ...PENDING_SESSION, orderState: 'PLACED' } });
    const received = lockStatusEndpoint(() =>
      HttpResponse.json(lockStatusResponse({ status: 'RELEASED', ttl_ms: 0, expires_at: null })),
    );

    const { unmount } = renderHookWithProviders(() => useLockStatus({ intervalMs: FAST_POLL_MS }));
    await sleep(FAST_POLL_MS * 5);
    unmount();

    expect(received).toHaveLength(0);
  });

  it('polls repeatedly with the order id and Bearer token while the lock is ACTIVE', async () => {
    useCheckoutStore.setState({ session: PENDING_SESSION });
    const received = lockStatusEndpoint((call) =>
      HttpResponse.json(
        lockStatusResponse({
          status: 'ACTIVE',
          ttl_ms: 600_000 - call * 1000,
          expires_at: '2026-09-29T10:10:30.000Z',
        }),
      ),
    );

    const { unmount } = renderHookWithProviders(() => useLockStatus({ intervalMs: FAST_POLL_MS }));
    await waitFor(() => {
      expect(received.length).toBeGreaterThanOrEqual(3);
    });
    unmount();

    for (const request of received) {
      expect(request.url.pathname).toBe('/api/cart/lock-status');
      expect(request.url.searchParams.get('order_id')).toBe(ORDER_ID);
      expect(request.headers.get('authorization')).toBe(`Bearer ${TEST_ACCESS_TOKEN}`);
    }
    // ACTIVE resumes checkout and refreshes the countdown target.
    expect(useCheckoutStore.getState().session?.expiresAt).toBe('2026-09-29T10:10:30.000Z');
    expect(useCartStore.getState().lines).toHaveLength(1);
  });

  it('purges the cart, shows "Session Expired" and stops polling when the TTL hits 0', async () => {
    useCheckoutStore.setState({ session: PENDING_SESSION });
    const received = lockStatusEndpoint((call) =>
      HttpResponse.json(
        call < 2
          ? lockStatusResponse({
              status: 'ACTIVE',
              ttl_ms: 1000,
              expires_at: PENDING_SESSION.expiresAt,
            })
          : lockStatusResponse({ status: 'EXPIRED', ttl_ms: 0, expires_at: null }),
      ),
    );

    const { unmount } = renderHookWithProviders(() => useLockStatus({ intervalMs: FAST_POLL_MS }));
    await waitFor(() => {
      expect(useCheckoutStore.getState().sessionExpired).toBe(true);
    });
    const callsAtExpiry = received.length;
    await sleep(FAST_POLL_MS * 5);
    unmount();

    expect(useCartStore.getState()).toMatchObject({ vendor: null, lines: [] });
    expect(useCheckoutStore.getState().session).toBeNull();
    expect(received).toHaveLength(callsAtExpiry);
  });

  it('keeps polling through network failures, then resumes on reconnect (SPEC edge case 1)', async () => {
    useCheckoutStore.setState({ session: PENDING_SESSION });
    const received = lockStatusEndpoint((call) =>
      call <= 2
        ? HttpResponse.error()
        : HttpResponse.json(
            lockStatusResponse({
              status: 'ACTIVE',
              ttl_ms: 5000,
              expires_at: '2026-09-29T10:09:59.000Z',
            }),
          ),
    );

    const { unmount } = renderHookWithProviders(() => useLockStatus({ intervalMs: FAST_POLL_MS }));
    await waitFor(() => {
      expect(useCheckoutStore.getState().session?.expiresAt).toBe('2026-09-29T10:09:59.000Z');
    });
    unmount();

    expect(received.length).toBeGreaterThanOrEqual(3);
    expect(useCartStore.getState().lines).toHaveLength(1);
  });

  it('clears the cart and stops polling once payment is confirmed (RELEASED, PLACED)', async () => {
    useCheckoutStore.setState({ session: PENDING_SESSION });
    const received = lockStatusEndpoint(() =>
      HttpResponse.json(
        lockStatusResponse(
          { status: 'RELEASED', ttl_ms: 0, expires_at: null },
          { state: 'PLACED', payment_status: 'PAID' },
        ),
      ),
    );

    const { unmount } = renderHookWithProviders(() => useLockStatus({ intervalMs: FAST_POLL_MS }));
    await waitFor(() => {
      expect(useCheckoutStore.getState().session?.orderState).toBe('PLACED');
    });
    await sleep(FAST_POLL_MS * 5);
    unmount();

    expect(received).toHaveLength(1);
    expect(useCartStore.getState().lines).toHaveLength(0);
    expect(useCheckoutStore.getState().sessionExpired).toBe(false);
  });

  it('treats 410 RESERVATION_EXPIRED as an expired session', async () => {
    useCheckoutStore.setState({ session: PENDING_SESSION });
    lockStatusEndpoint(() => HttpResponse.json(errorBody('RESERVATION_EXPIRED'), { status: 410 }));

    const { unmount } = renderHookWithProviders(() => useLockStatus({ intervalMs: FAST_POLL_MS }));
    await waitFor(() => {
      expect(useCheckoutStore.getState().sessionExpired).toBe(true);
    });
    unmount();

    expect(useCartStore.getState().lines).toHaveLength(0);
  });

  it('ends the session when the order is not found for this customer', async () => {
    useCheckoutStore.setState({ session: PENDING_SESSION });
    lockStatusEndpoint(() => HttpResponse.json(errorBody('ORDER_NOT_FOUND'), { status: 404 }));

    const { unmount } = renderHookWithProviders(() => useLockStatus({ intervalMs: FAST_POLL_MS }));
    await waitFor(() => {
      expect(useCheckoutStore.getState().session).toBeNull();
    });
    unmount();

    expect(useCheckoutStore.getState().sessionExpired).toBe(false);
    expect(useCartStore.getState().lines).toHaveLength(1);
  });
});
