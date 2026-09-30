import type { OrderSnapshotView, OrderState, OrderStateUpdate } from '@hamro-pasal/shared-types';
import { act, screen } from '@testing-library/react-native';
import { http, HttpResponse } from 'msw';

import OrderTrackingScreen from '../../../app/order/[id]';
import { TOKEN_REFRESH_PATH } from '../../api/http';
import { orderPath } from '../../api/orders';
import { useAuthStore } from '../../store/useAuthStore';
import { useDeliveryOtpStore } from '../../store/useDeliveryOtpStore';
import { useOrderStore } from '../../store/useOrderStore';
import { errorBody, ORDER_ID, orderDetailResponse } from '../../test/api-fixtures';
import { FakeSocket } from '../../test/fake-socket';
import { apiUrl, server, setupApiTestEnvironment, TEST_ACCESS_TOKEN } from '../../test/msw';
import { createTestQueryClient, renderWithProviders } from '../../test/render';
import { orderQueryKey } from './order-hooks';

let mockSocket = new FakeSocket();
jest.mock('socket.io-client', () => ({
  io: (url: string, options: { auth?: unknown }) => mockSocket.created(url, options),
}));

jest.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ id: '0b7e9c1a-2f4d-4c8e-9a6b-1d2e3f4a5b6c' }),
  Stack: { Screen: () => null },
  router: { push: jest.fn() },
}));

setupApiTestEnvironment();

const NOW = Date.parse('2026-09-30T10:00:00.000Z');
const OTHER_ORDER_ID = '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f';

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(ms);
  });
}

/** GET /api/orders/:id answers `state`; returns how many times it was called. */
function serveOrder(state: OrderState, acceptToken: (auth: string | null) => boolean = () => true) {
  let calls = 0;
  server.use(
    http.get(apiUrl(orderPath(ORDER_ID)), ({ request }) => {
      calls += 1;
      if (!acceptToken(request.headers.get('authorization'))) {
        return HttpResponse.json(errorBody('UNAUTHENTICATED'), { status: 401 });
      }
      return HttpResponse.json(orderDetailResponse({ state, payment_method: 'COD' }));
    }),
  );
  return { calls: () => calls };
}

function trackOrder(state: OrderState): void {
  useOrderStore.setState({
    orders: {
      [ORDER_ID]: {
        orderId: ORDER_ID,
        // Placed long ago: the cancellation window is closed, the tracker shows server states.
        placedAt: NOW - 10 * 60_000,
        deliveredAt: null,
        state,
        paymentMethod: 'COD',
        totalNpr: 1250,
      },
    },
  });
}

function update(state: OrderState, overrides: Partial<OrderStateUpdate> = {}): OrderStateUpdate {
  return {
    order_id: ORDER_ID,
    state,
    payment_status: 'PENDING',
    refund_required: false,
    placed_at: '2026-09-30T09:50:00.000Z',
    delivered_at: state === 'DELIVERED' ? '2026-09-30T10:05:00.000Z' : null,
    changed_at: new Date(Date.now()).toISOString(),
    ...overrides,
  };
}

async function renderScreen() {
  const queryClient = createTestQueryClient();
  renderWithProviders(<OrderTrackingScreen />, { queryClient });
  await advance(0);
  return queryClient;
}

/** Plays the server's answer to the latest orders:subscribe. */
function acceptSubscription(): void {
  mockSocket.answerLast('orders:subscribe', { ok: true, order_id: ORDER_ID });
}

const stepLabel = (label: string) => screen.getByLabelText(label);
const subscriptions = () => mockSocket.emittedOf('orders:subscribe');

beforeEach(() => {
  mockSocket = new FakeSocket();
  jest.useFakeTimers({ now: NOW });
  useAuthStore.getState().setLocale('en');
  useOrderStore.setState({ orders: {} });
  useDeliveryOtpStore.setState({ otps: { [ORDER_ID]: '4821' } });
});

afterEach(() => {
  jest.useRealTimers();
});

describe('order tracking over Socket.io /orders', () => {
  it('connects to /orders with the access token and joins the order room', async () => {
    trackOrder('PREPARING');
    serveOrder('PREPARING');
    await renderScreen();

    expect(mockSocket.url).toBe('http://api.hamropasal.test/orders');
    expect(mockSocket.handshakes).toEqual([{ token: TEST_ACCESS_TOKEN }]);
    expect(subscriptions()).toEqual([{ order_id: ORDER_ID }]);
  });

  it('advances the tracker instantly on order:state_update and patches the query cache', async () => {
    trackOrder('PREPARING');
    const order = serveOrder('PREPARING');
    const queryClient = await renderScreen();
    acceptSubscription();
    await advance(0);
    const getsBefore = order.calls();
    expect(stepLabel('Preparing: in progress')).toBeOnTheScreen();

    mockSocket.serverSend('order:state_update', update('OUT_FOR_DELIVERY'));

    expect(stepLabel('Preparing: done')).toBeOnTheScreen();
    expect(stepLabel('Out for Delivery: in progress')).toBeOnTheScreen();
    expect(useOrderStore.getState().orders[ORDER_ID]?.state).toBe('OUT_FOR_DELIVERY');
    expect(queryClient.getQueryData<OrderSnapshotView>(orderQueryKey(ORDER_ID))).toMatchObject({
      id: ORDER_ID,
      state: 'OUT_FOR_DELIVERY',
      // The rest of the snapshot is kept, not refetched.
      items: [expect.objectContaining({ product_id: expect.any(String) as unknown })],
    });
    expect(order.calls()).toBe(getsBefore); // no HTTP round trip for the update
  });

  it('no longer polls GET /api/orders/:id every 30 s', async () => {
    trackOrder('PREPARING');
    const order = serveOrder('PREPARING');
    await renderScreen();
    const afterMount = order.calls();

    await advance(5 * 60_000);

    expect(afterMount).toBe(1);
    expect(order.calls()).toBe(1);
  });

  it('finishes the order on DELIVERED: tracker complete, OTP erased, socket closed', async () => {
    trackOrder('OUT_FOR_DELIVERY');
    serveOrder('OUT_FOR_DELIVERY');
    await renderScreen();
    expect(screen.getByTestId('delivery-otp')).toBeOnTheScreen();

    mockSocket.serverSend('order:state_update', update('DELIVERED'));

    expect(stepLabel('Delivered: done')).toBeOnTheScreen();
    expect(screen.queryByTestId('delivery-otp')).toBeNull();
    expect(useDeliveryOtpStore.getState().otps[ORDER_ID]).toBeUndefined();
    expect(mockSocket.connected).toBe(false);
  });

  it('shows a cancellation made elsewhere (e.g. another device)', async () => {
    trackOrder('PLACED');
    serveOrder('PLACED');
    await renderScreen();

    mockSocket.serverSend('order:state_update', update('CANCELED'));

    expect(screen.getByText('Order cancelled')).toBeOnTheScreen();
    expect(screen.queryByTestId('order-tracker')).toBeNull();
  });

  it('ignores updates for other orders, malformed payloads and stale (older) updates', async () => {
    trackOrder('PREPARING');
    serveOrder('PREPARING');
    await renderScreen();

    mockSocket.serverSend('order:state_update', update('DELIVERED', { order_id: OTHER_ORDER_ID }));
    mockSocket.serverSend('order:state_update', { order_id: ORDER_ID, state: 'DELIVERED' });
    mockSocket.serverSend('order:state_update', update('OUT_FOR_DELIVERY'));
    mockSocket.serverSend(
      'order:state_update',
      update('PREPARING', { changed_at: new Date(NOW - 60_000).toISOString() }),
    );

    expect(stepLabel('Out for Delivery: in progress')).toBeOnTheScreen();
    expect(useOrderStore.getState().orders[ORDER_ID]?.state).toBe('OUT_FOR_DELIVERY');
  });

  it('re-subscribes after every reconnect and catches up with one GET per join', async () => {
    trackOrder('PREPARING');
    const order = serveOrder('PREPARING');
    await renderScreen();
    acceptSubscription();
    await advance(0);
    const afterFirstJoin = order.calls();

    mockSocket.drop();
    const whileOffline = serveOrder('OUT_FOR_DELIVERY'); // changed while the device was offline
    mockSocket.reconnect();
    await advance(0);
    expect(subscriptions()).toEqual([{ order_id: ORDER_ID }, { order_id: ORDER_ID }]);
    expect(whileOffline.calls()).toBe(0); // not before the room is joined

    acceptSubscription();
    await advance(0);

    expect(stepLabel('Out for Delivery: in progress')).toBeOnTheScreen();
    expect(whileOffline.calls()).toBe(1);
    expect(afterFirstJoin).toBe(2); // mount + catch-up after the first join
  });

  it('does not retry a subscription the server refuses', async () => {
    trackOrder('PREPARING');
    serveOrder('PREPARING');
    await renderScreen();

    mockSocket.answerLast('orders:subscribe', {
      ok: false,
      error: { code: 'ORDER_NOT_FOUND', message: 'Order not found' },
    });
    await advance(60_000);

    expect(subscriptions()).toHaveLength(1);
  });

  it('retries a subscription whose acknowledgement timed out', async () => {
    trackOrder('PREPARING');
    serveOrder('PREPARING');
    await renderScreen();

    mockSocket.answerLast('orders:subscribe', undefined, new Error('operation has timed out'));
    await advance(1_000);

    expect(subscriptions()).toHaveLength(2);
  });
});

describe('socket token lifecycle', () => {
  const REFRESH = 'stored.refresh.token';
  const RENEWED = 'renewed.access.token';
  const EXPIRED = 'expired.access.token';

  function serveRefresh(
    respond: () => Response = () =>
      HttpResponse.json({
        token_type: 'Bearer',
        access_token: RENEWED,
        access_token_expires_in: 900,
      }),
  ) {
    let calls = 0;
    server.use(
      http.post(apiUrl(TOKEN_REFRESH_PATH), () => {
        calls += 1;
        return respond();
      }),
    );
    return { calls: () => calls };
  }

  it('after a relaunch (no access token in memory) refreshes over HTTP before the handshake', async () => {
    useAuthStore.setState({ accessToken: null, refreshToken: REFRESH });
    const refresh = serveRefresh();
    serveOrder('PREPARING', (auth) => auth === `Bearer ${RENEWED}`);
    mockSocket.acceptToken = (token) => token === RENEWED;
    trackOrder('PREPARING');

    await renderScreen();

    expect(mockSocket.handshakes).toEqual([{ token: RENEWED }]);
    expect(mockSocket.connected).toBe(true);
    expect(subscriptions()).toEqual([{ order_id: ORDER_ID }]);
    // The screen's GET and the socket needed a token at once: one shared refresh call.
    expect(refresh.calls()).toBe(1);
    expect(useAuthStore.getState().accessToken).toBe(RENEWED);

    mockSocket.serverSend('order:state_update', update('OUT_FOR_DELIVERY'));
    expect(stepLabel('Out for Delivery: in progress')).toBeOnTheScreen();
  });

  it('renews a token the server rejects (expired while offline) and reconnects', async () => {
    useAuthStore.getState().setSession({ accessToken: EXPIRED, refreshToken: REFRESH });
    const refresh = serveRefresh();
    serveOrder('PREPARING', (auth) => auth === `Bearer ${RENEWED}`);
    mockSocket.acceptToken = (token) => token === RENEWED;
    trackOrder('PREPARING');

    await renderScreen();
    await advance(0);

    expect(mockSocket.handshakes).toEqual([{ token: EXPIRED }, { token: RENEWED }]);
    expect(mockSocket.connected).toBe(true);
    expect(subscriptions()).toEqual([{ order_id: ORDER_ID }]);
    expect(refresh.calls()).toBe(1);
  });

  it('stays disconnected and signs out when the refresh token is refused', async () => {
    useAuthStore.getState().setSession({ accessToken: EXPIRED, refreshToken: REFRESH });
    serveRefresh(() => HttpResponse.json(errorBody('REFRESH_TOKEN_INVALID'), { status: 401 }));
    serveOrder('PREPARING', () => false);
    mockSocket.acceptToken = () => false;
    trackOrder('PREPARING');

    await renderScreen();
    await advance(60_000);

    expect(mockSocket.handshakes).toEqual([{ token: EXPIRED }]);
    expect(mockSocket.connected).toBe(false);
    expect(useAuthStore.getState()).toMatchObject({ accessToken: null, refreshToken: null });
  });

  it('does not loop when even a freshly renewed token is refused', async () => {
    useAuthStore.getState().setSession({ accessToken: EXPIRED, refreshToken: REFRESH });
    const refresh = serveRefresh();
    serveOrder('PREPARING');
    // Refuses every token, but gives in after a few attempts so a regression fails the
    // assertions below instead of hanging the test in an endless reconnect loop.
    mockSocket.acceptToken = () => mockSocket.handshakes.length > 4;
    trackOrder('PREPARING');

    await renderScreen();
    await advance(60_000);

    expect(mockSocket.handshakes).toEqual([{ token: EXPIRED }, { token: RENEWED }]);
    expect(refresh.calls()).toBe(1);
    expect(mockSocket.connected).toBe(false);
  });

  it('keeps the session and retries with backoff when the refresh fails on the network', async () => {
    useAuthStore.setState({ accessToken: null, refreshToken: REFRESH });
    // The network is down for the first half second (fake clock), then recovers.
    serveRefresh(() =>
      Date.now() < NOW + 500
        ? HttpResponse.error()
        : HttpResponse.json({
            token_type: 'Bearer',
            access_token: RENEWED,
            access_token_expires_in: 900,
          }),
    );
    serveOrder('PREPARING');
    mockSocket.acceptToken = (token) => token === RENEWED;
    trackOrder('PREPARING');

    await renderScreen();
    expect(mockSocket.handshakes).toEqual([{ token: null }]);
    expect(mockSocket.connected).toBe(false);
    // A network failure never signs anyone out.
    expect(useAuthStore.getState().refreshToken).toBe(REFRESH);

    await advance(1_000); // first backoff step

    expect(mockSocket.handshakes).toEqual([{ token: null }, { token: RENEWED }]);
    expect(mockSocket.connected).toBe(true);
    expect(subscriptions()).toEqual([{ order_id: ORDER_ID }]);
  });
});
