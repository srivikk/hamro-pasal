import type { OrderState, OrderStateUpdate, VendorOrderView } from '@hamro-pasal/shared-types';
import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import { http, HttpResponse } from 'msw';

import VendorDashboardScreen from '../../../app/(vendor)/dashboard';
import { VENDOR_ORDERS_PATH, vendorOrderDecisionPath } from '../../api/vendor-orders';
import { useAuthStore } from '../../store/useAuthStore';
import { useToastStore } from '../../store/useToastStore';
import {
  errorBody,
  NEW_ORDER_ID,
  SECOND_ORDER_ID,
  THAMEL_VENDOR,
  vendorDecision,
  vendorOrder,
  vendorOrderList,
} from '../../test/api-fixtures';
import { mockAudio, onlyPlayer, resetMockAudio } from '../../test/fake-audio';
import { FakeSocket } from '../../test/fake-socket';
import { apiUrl, server, setupApiTestEnvironment, TEST_ACCESS_TOKEN } from '../../test/msw';
import { renderWithProviders } from '../../test/render';

let mockSocket = new FakeSocket();
jest.mock('socket.io-client', () => ({
  io: (url: string, options: { auth?: unknown }) => mockSocket.created(url, options),
}));

jest.mock('expo-router', () => ({
  Stack: { Screen: () => null },
  router: { push: jest.fn(), replace: jest.fn() },
}));

setupApiTestEnvironment();

/** What GET /api/vendors/orders answers right now (tests change it as the "server" moves on). */
let serverOrders: VendorOrderView[] = [];
let listRequests = 0;

function serveOrderList(): void {
  server.use(
    http.get(apiUrl(VENDOR_ORDERS_PATH), () => {
      listRequests += 1;
      return HttpResponse.json(vendorOrderList(serverOrders));
    }),
  );
}

/**
 * Serves one decision. The response waits for `release()`, so a test can look at the alarm while
 * the request is still in flight (the vendor has pressed, the server has not answered yet).
 */
function serveDecision(
  orderId: string,
  decision: 'accept' | 'reject',
  respond: () => Response,
): { release: () => void; requests: () => number } {
  let requests = 0;
  let open: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  server.use(
    http.post(apiUrl(vendorOrderDecisionPath(orderId, decision)), async () => {
      requests += 1;
      await gate;
      return respond();
    }),
  );
  return { release: open, requests: () => requests };
}

function stateUpdate(orderId: string, state: OrderState): OrderStateUpdate {
  return {
    order_id: orderId,
    state,
    payment_status: 'PENDING',
    refund_required: false,
    placed_at: '2026-09-30T10:00:00.000Z',
    delivered_at: null,
    changed_at: new Date().toISOString(),
  };
}

/** The API answers the dashboard's vendor:subscribe: it is now in the shop's room. */
function joinShopRoom(): void {
  mockSocket.answerLast('vendor:subscribe', { ok: true, vendor_id: THAMEL_VENDOR.id });
}

/** A customer places an order: the worker broadcasts PLACED to the shop's room. */
function orderArrives(order: VendorOrderView): void {
  serverOrders = [...serverOrders, order];
  mockSocket.serverSend('order:state_update', stateUpdate(order.id, 'PLACED'));
}

async function renderDashboard(): Promise<void> {
  renderWithProviders(<VendorDashboardScreen />);
  await waitFor(() => {
    expect(listRequests).toBeGreaterThan(0);
  });
  await waitFor(() => {
    expect(screen.queryByTestId('vendor-orders-loading')).not.toBeOnTheScreen();
  });
}

const orderCard = (orderId: string) => screen.queryByTestId(`vendor-order-${orderId}`);
const alarmBanner = () => screen.queryByTestId('vendor-alarm-banner');

beforeEach(() => {
  mockSocket = new FakeSocket();
  resetMockAudio();
  serverOrders = [];
  listRequests = 0;
  useAuthStore.getState().setLocale('en');
  useToastStore.setState({ toast: null });
  serveOrderList();
});

describe('vendor dashboard: incoming orders over Socket.io /orders', () => {
  it("joins the shop's room with the access token", async () => {
    await renderDashboard();

    expect(mockSocket.url).toBe('http://api.hamropasal.test/orders');
    expect(mockSocket.handshakes).toEqual([{ token: TEST_ACCESS_TOKEN }]);
    expect(mockSocket.emittedOf('vendor:subscribe')).toEqual([{}]);
  });

  it('refetches the open orders after joining (orders placed before the join are not missed)', async () => {
    await renderDashboard();
    const before = listRequests;

    joinShopRoom();

    await waitFor(() => {
      expect(listRequests).toBe(before + 1);
    });
  });

  it('never retries a join the server refused', async () => {
    await renderDashboard();

    mockSocket.answerLast('vendor:subscribe', {
      ok: false,
      error: { code: 'VENDOR_NOT_FOUND', message: 'Vendor not found' },
    });
    await new Promise((resolve) => setTimeout(resolve, 1_200));

    expect(mockSocket.emittedOf('vendor:subscribe')).toHaveLength(1);
  });
});

describe('vendor dashboard: the incoming-order alarm (expo-audio)', () => {
  it('is silent while no order is waiting', async () => {
    await renderDashboard();
    joinShopRoom();

    expect(screen.getByTestId('vendor-orders-empty')).toBeOnTheScreen();
    expect(mockAudio.players.every((player) => player.play.mock.calls.length === 0)).toBe(true);
    expect(alarmBanner()).not.toBeOnTheScreen();
  });

  it('starts a looping, full-volume alarm when a new PLACED order arrives', async () => {
    await renderDashboard();
    joinShopRoom();

    orderArrives(vendorOrder());

    await waitFor(() => {
      expect(orderCard(NEW_ORDER_ID)).toBeOnTheScreen();
    });
    const player = onlyPlayer();
    expect(player.play).toHaveBeenCalledTimes(1);
    expect(player.loop).toBe(true);
    expect(player.volume).toBe(1);
    expect(player.pause).not.toHaveBeenCalled();
    expect(mockAudio.modes).toContainEqual({
      playsInSilentMode: true,
      interruptionMode: 'doNotMix',
    });
    expect(alarmBanner()).toBeOnTheScreen();
    expect(screen.getByText('2 × Wai Wai Noodles (carton of 30)')).toBeOnTheScreen();
    expect(screen.getByText('Ward 26, Thamel, Kathmandu Metropolitan City')).toBeOnTheScreen();
  });

  it('keeps looping (no restart) while other updates come in', async () => {
    await renderDashboard();
    orderArrives(vendorOrder());
    await waitFor(() => {
      expect(orderCard(NEW_ORDER_ID)).toBeOnTheScreen();
    });

    mockSocket.serverSend('order:state_update', stateUpdate(NEW_ORDER_ID, 'PLACED'));
    await waitFor(() => {
      expect(listRequests).toBeGreaterThanOrEqual(3);
    });

    expect(onlyPlayer().play).toHaveBeenCalledTimes(1);
    expect(onlyPlayer().pause).not.toHaveBeenCalled();
  });

  it('rings for an order already waiting when the dashboard opens', async () => {
    serverOrders = [vendorOrder()];

    await renderDashboard();

    await waitFor(() => {
      expect(onlyPlayer().play).toHaveBeenCalledTimes(1);
    });
  });

  it('Accept stops the alarm at once, then shows the order as Preparing', async () => {
    const accept = serveDecision(NEW_ORDER_ID, 'accept', () =>
      HttpResponse.json(vendorDecision(NEW_ORDER_ID, 'PREPARING')),
    );
    await renderDashboard();
    orderArrives(vendorOrder());
    await waitFor(() => {
      expect(orderCard(NEW_ORDER_ID)).toBeOnTheScreen();
    });
    const player = onlyPlayer();

    fireEvent.press(screen.getByTestId(`accept-${NEW_ORDER_ID}`));

    // Silenced on the press, before the server has answered.
    await waitFor(() => {
      expect(player.pause).toHaveBeenCalledTimes(1);
    });
    expect(player.seekTo).toHaveBeenCalledWith(0);
    expect(player.playing).toBe(false);
    expect(accept.requests()).toBe(1);
    expect(alarmBanner()).not.toBeOnTheScreen();
    expect(screen.getByText('Sending…')).toBeOnTheScreen();

    serverOrders = [vendorOrder({ state: 'PREPARING' })];
    accept.release();

    await waitFor(() => {
      expect(useToastStore.getState().toast?.message).toBe('Order accepted. Start preparing it.');
    });
    expect(screen.getByTestId('stage-count-PREPARING')).toHaveTextContent('1');
    expect(screen.getByTestId('stage-count-NEW')).toHaveTextContent('0');
    expect(screen.queryByTestId(`accept-${NEW_ORDER_ID}`)).not.toBeOnTheScreen();
    fireEvent.press(screen.getByTestId('stage-PREPARING'));
    expect(orderCard(NEW_ORDER_ID)).toBeOnTheScreen();
    expect(player.play).toHaveBeenCalledTimes(1); // it did not start again
  });

  it('Reject stops the alarm and removes the order (a prepaid refund is announced)', async () => {
    const reject = serveDecision(NEW_ORDER_ID, 'reject', () =>
      HttpResponse.json(vendorDecision(NEW_ORDER_ID, 'CANCELED', true)),
    );
    await renderDashboard();
    orderArrives(vendorOrder({ payment_method: 'ESEWA', payment_status: 'PAID' }));
    await waitFor(() => {
      expect(orderCard(NEW_ORDER_ID)).toBeOnTheScreen();
    });
    const player = onlyPlayer();

    fireEvent.press(screen.getByTestId(`reject-${NEW_ORDER_ID}`));

    await waitFor(() => {
      expect(player.pause).toHaveBeenCalledTimes(1);
    });
    expect(reject.requests()).toBe(1);
    serverOrders = [];
    reject.release();

    await waitFor(() => {
      expect(orderCard(NEW_ORDER_ID)).not.toBeOnTheScreen();
    });
    expect(useToastStore.getState().toast?.message).toBe(
      "Order rejected. The customer's payment will be refunded.",
    );
    expect(player.play).toHaveBeenCalledTimes(1);
  });

  it('keeps ringing until every waiting order has been answered', async () => {
    const first = serveDecision(NEW_ORDER_ID, 'accept', () =>
      HttpResponse.json(vendorDecision(NEW_ORDER_ID, 'PREPARING')),
    );
    const second = serveDecision(SECOND_ORDER_ID, 'reject', () =>
      HttpResponse.json(vendorDecision(SECOND_ORDER_ID, 'CANCELED')),
    );
    await renderDashboard();
    orderArrives(vendorOrder());
    orderArrives(vendorOrder({ id: SECOND_ORDER_ID }));
    await waitFor(() => {
      expect(orderCard(SECOND_ORDER_ID)).toBeOnTheScreen();
    });
    const player = onlyPlayer();

    fireEvent.press(screen.getByTestId(`accept-${NEW_ORDER_ID}`));
    await waitFor(() => {
      expect(first.requests()).toBe(1);
    });
    expect(player.pause).not.toHaveBeenCalled(); // the second order is still waiting
    expect(alarmBanner()).toBeOnTheScreen();

    fireEvent.press(screen.getByTestId(`reject-${SECOND_ORDER_ID}`));
    await waitFor(() => {
      expect(player.pause).toHaveBeenCalledTimes(1);
    });
    expect(second.requests()).toBe(1);
    first.release();
    second.release();
  });

  it('rings again if the answer could not be sent, so the order is not forgotten', async () => {
    const accept = serveDecision(NEW_ORDER_ID, 'accept', () =>
      HttpResponse.json(errorBody('INTERNAL_SERVER_ERROR'), { status: 500 }),
    );
    await renderDashboard();
    orderArrives(vendorOrder());
    await waitFor(() => {
      expect(orderCard(NEW_ORDER_ID)).toBeOnTheScreen();
    });
    const player = onlyPlayer();

    fireEvent.press(screen.getByTestId(`accept-${NEW_ORDER_ID}`));
    await waitFor(() => {
      expect(player.pause).toHaveBeenCalledTimes(1);
    });
    accept.release();

    await waitFor(() => {
      expect(player.play).toHaveBeenCalledTimes(2);
    });
    expect(player.playing).toBe(true);
    expect(useToastStore.getState().toast).toMatchObject({
      message: "Couldn't send your answer. Please try again.",
      tone: 'error',
    });
    expect(screen.getByTestId(`accept-${NEW_ORDER_ID}`)).toBeOnTheScreen();
  });

  it('stays silent when the order moved on meanwhile (409), and refreshes the list', async () => {
    const accept = serveDecision(NEW_ORDER_ID, 'accept', () =>
      HttpResponse.json(errorBody('ORDER_STATE_CONFLICT', { state: 'CANCELED' }), { status: 409 }),
    );
    await renderDashboard();
    orderArrives(vendorOrder());
    await waitFor(() => {
      expect(orderCard(NEW_ORDER_ID)).toBeOnTheScreen();
    });
    const player = onlyPlayer();

    fireEvent.press(screen.getByTestId(`accept-${NEW_ORDER_ID}`));
    serverOrders = []; // the customer canceled inside their 60 s window
    accept.release();

    await waitFor(() => {
      expect(orderCard(NEW_ORDER_ID)).not.toBeOnTheScreen();
    });
    expect(useToastStore.getState().toast?.message).toBe(
      'This order is no longer waiting for you.',
    );
    expect(player.play).toHaveBeenCalledTimes(1);
    expect(player.playing).toBe(false);
  });

  it('stops by itself when the customer cancels before the vendor answers', async () => {
    await renderDashboard();
    orderArrives(vendorOrder());
    await waitFor(() => {
      expect(onlyPlayer().play).toHaveBeenCalledTimes(1);
    });

    serverOrders = [];
    mockSocket.serverSend('order:state_update', stateUpdate(NEW_ORDER_ID, 'CANCELED'));

    await waitFor(() => {
      expect(onlyPlayer().pause).toHaveBeenCalledTimes(1);
    });
    expect(alarmBanner()).not.toBeOnTheScreen();
  });

  it('silences and frees the player when the vendor leaves the dashboard', async () => {
    serverOrders = [vendorOrder()];
    await renderDashboard();
    await waitFor(() => {
      expect(onlyPlayer().play).toHaveBeenCalledTimes(1);
    });

    screen.unmount();

    expect(onlyPlayer().pause).toHaveBeenCalledTimes(1);
    expect(onlyPlayer().remove).toHaveBeenCalledTimes(1);
  });
});
