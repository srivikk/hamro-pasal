import type { VendorOrderView } from '@hamro-pasal/shared-types';
import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { delay, http, HttpResponse } from 'msw';

import VendorDashboardScreen from '../../../app/(vendor)/dashboard';
import { VENDOR_ORDERS_PATH, vendorOrderDecisionPath } from '../../api/vendor-orders';
import { useToastStore } from '../../store/useToastStore';
import { useVendorBoardStore } from '../../store/useVendorBoardStore';
import {
  deliveryCompleted,
  errorBody,
  NEW_ORDER_ID,
  SECOND_ORDER_ID,
  vendorOrder,
  vendorOrderList,
} from '../../test/api-fixtures';
import { resetMockAudio } from '../../test/fake-audio';
import { FakeSocket } from '../../test/fake-socket';
import { apiUrl, capture, server, setupApiTestEnvironment } from '../../test/msw';
import { renderWithProviders } from '../../test/render';
import type { BoardStage } from './order-board';

let mockSocket = new FakeSocket();
jest.mock('socket.io-client', () => ({
  io: (url: string, options: { auth?: unknown }) => mockSocket.created(url, options),
}));

jest.mock('expo-router', () => ({
  Stack: { Screen: () => null },
  router: { push: jest.fn(), replace: jest.fn() },
}));

setupApiTestEnvironment();

/**
 * Phase 11.5: after accepting, the vendor dispatches (vendor flow step 8) and, for the shop's own
 * SELF_DELIVERY orders, types the customer's code at the door (step 9). Real apiRequest over msw,
 * real TanStack mutations.
 */

/** What GET /api/vendors/orders answers right now (tests change it as the "server" moves on). */
let serverOrders: VendorOrderView[] = [];
let posts: { path: string; body: unknown }[] = [];

function serveOrderList(): void {
  server.use(
    http.get(apiUrl(VENDOR_ORDERS_PATH), () => HttpResponse.json(vendorOrderList(serverOrders))),
  );
}

function servePost(
  orderId: string,
  action: 'dispatch' | 'deliver',
  respond: () => Response | Promise<Response>,
): void {
  server.use(
    http.post(apiUrl(vendorOrderDecisionPath(orderId, action)), async ({ request }) => {
      posts.push({ path: new URL(request.url).pathname, body: (await capture(request)).body });
      return respond();
    }),
  );
}

/** Opens the dashboard and, when asked, the board column the test works in. */
async function renderDashboard(stage?: BoardStage): Promise<void> {
  renderWithProviders(<VendorDashboardScreen />);
  await waitFor(() => {
    expect(screen.queryByTestId('vendor-orders-loading')).not.toBeOnTheScreen();
  });
  if (stage !== undefined) await showStage(stage);
}

/** Waits for the column to hold an order (the list request may still be on its way), then opens it. */
async function showStage(stage: BoardStage): Promise<void> {
  await waitFor(() => {
    expect(screen.getByTestId(`stage-count-${stage}`)).not.toHaveTextContent(/^[0०]$/);
  });
  fireEvent.press(screen.getByTestId(`stage-${stage}`));
}

const card = (orderId = NEW_ORDER_ID) => screen.queryByTestId(`vendor-order-${orderId}`);
const dispatchButton = (orderId = NEW_ORDER_ID) => screen.queryByTestId(`dispatch-${orderId}`);
const codeInput = (orderId = NEW_ORDER_ID) => screen.queryByTestId(`delivery-otp-${orderId}`);
const toast = () => useToastStore.getState().toast;

const preparing = (overrides: Partial<VendorOrderView> = {}) =>
  vendorOrder({ state: 'PREPARING', ...overrides });
const onTheRoad = (overrides: Partial<VendorOrderView> = {}) =>
  vendorOrder({ state: 'OUT_FOR_DELIVERY', fulfillment: 'SELF_DELIVERY', ...overrides });

beforeEach(() => {
  mockSocket = new FakeSocket();
  resetMockAudio();
  serverOrders = [];
  posts = [];
  useToastStore.setState({ toast: null });
  useVendorBoardStore.getState().reset();
  serveOrderList();
});

describe('vendor dashboard: Dispatch', () => {
  it('offers Dispatch on PREPARING orders only', async () => {
    serverOrders = [vendorOrder(), preparing({ id: SECOND_ORDER_ID })];

    await renderDashboard();

    await waitFor(() => {
      expect(card(NEW_ORDER_ID)).toBeOnTheScreen(); // PLACED: Accept / Reject, under New
    });
    expect(dispatchButton(NEW_ORDER_ID)).not.toBeOnTheScreen();
    expect(card(SECOND_ORDER_ID)).not.toBeOnTheScreen();

    await showStage('PREPARING');

    expect(dispatchButton(SECOND_ORDER_ID)).toBeOnTheScreen();
    expect(card(NEW_ORDER_ID)).not.toBeOnTheScreen();
  });

  it('dispatches a self-delivery order, which moves to Out for delivery with the code field', async () => {
    serverOrders = [preparing()];
    servePost(NEW_ORDER_ID, 'dispatch', async () => {
      await delay(100);
      serverOrders = [onTheRoad()];
      return HttpResponse.json({ order_id: NEW_ORDER_ID, state: 'OUT_FOR_DELIVERY' });
    });
    await renderDashboard('PREPARING');
    expect(codeInput()).not.toBeOnTheScreen();

    fireEvent.press(screen.getByTestId(`dispatch-${NEW_ORDER_ID}`));

    expect(await screen.findByText('Dispatching…')).toBeOnTheScreen();
    await showStage('READY');
    expect(codeInput()).toBeOnTheScreen();
    expect(dispatchButton()).not.toBeOnTheScreen();
    expect(screen.getByTestId('stage-count-PREPARING')).toHaveTextContent('0');
    expect(posts).toEqual([
      { path: `/api/vendors/orders/${NEW_ORDER_ID}/dispatch`, body: undefined },
    ]);
    expect(toast()).toMatchObject({
      message: 'Order dispatched. Collect the code at the door.',
      tone: 'success',
    });
  });

  it('keeps a dispatched fleet order under Ready until its delivery is announced', async () => {
    serverOrders = [preparing({ fulfillment: 'PLATFORM_FLEET' })];
    servePost(NEW_ORDER_ID, 'dispatch', () => {
      serverOrders = [];
      return HttpResponse.json({ order_id: NEW_ORDER_ID, state: 'OUT_FOR_DELIVERY' });
    });
    await renderDashboard('PREPARING');

    fireEvent.press(screen.getByTestId(`dispatch-${NEW_ORDER_ID}`));

    await waitFor(() => {
      expect(card()).not.toBeOnTheScreen();
    });
    expect(toast()?.message).toBe('Order dispatched. A rider will deliver it.');
    // The server no longer lists it; the board keeps it under Ready, waiting for its rider.
    await showStage('READY');
    expect(card()).toBeOnTheScreen();
    expect(
      screen.getByText('Riders have been told. Waiting for one to collect it.'),
    ).toBeOnTheScreen();
    expect(codeInput()).not.toBeOnTheScreen();
    // A live order has no stand-in for the rider: only the server can move it on.
    expect(screen.queryByTestId(`rider-pickup-${NEW_ORDER_ID}`)).not.toBeOnTheScreen();

    // The rider delivers: the shop's room hears it and the order is Handed Over.
    act(() => {
      mockSocket.serverSend('order:state_update', {
        order_id: NEW_ORDER_ID,
        state: 'DELIVERED',
        payment_status: 'PAID',
        refund_required: false,
        placed_at: '2026-09-30T10:00:00.000Z',
        delivered_at: new Date().toISOString(),
        changed_at: new Date().toISOString(),
      });
    });
    await showStage('HANDED_OVER');
    expect(card()).toBeOnTheScreen();
    expect(screen.getByTestId('stage-count-READY')).toHaveTextContent('0');
  });

  it('explains 422 CANCELLATION_WINDOW_OPEN with the seconds left and keeps Dispatch', async () => {
    serverOrders = [preparing()];
    servePost(NEW_ORDER_ID, 'dispatch', () =>
      HttpResponse.json(errorBody('CANCELLATION_WINDOW_OPEN', { retry_after_seconds: 37 }), {
        status: 422,
      }),
    );
    await renderDashboard('PREPARING');

    fireEvent.press(screen.getByTestId(`dispatch-${NEW_ORDER_ID}`));

    await waitFor(() => {
      expect(toast()).toMatchObject({
        message: 'The customer can still cancel for 37 s. Dispatch after that.',
        tone: 'error',
      });
    });
    expect(screen.getByTestId(`dispatch-${NEW_ORDER_ID}`)).toBeEnabled();
    expect(codeInput()).not.toBeOnTheScreen();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(posts).toHaveLength(1); // never retried by itself
  });

  it('shows the seconds in Nepali digits under ne', async () => {
    serverOrders = [preparing()];
    servePost(NEW_ORDER_ID, 'dispatch', () =>
      HttpResponse.json(errorBody('CANCELLATION_WINDOW_OPEN', { retry_after_seconds: 37 }), {
        status: 422,
      }),
    );
    renderWithProviders(<VendorDashboardScreen />, { locale: 'ne' });
    await showStage('PREPARING');

    fireEvent.press(screen.getByTestId(`dispatch-${NEW_ORDER_ID}`));

    await waitFor(() => {
      expect(toast()?.message).toContain('३७ सेकेन्ड');
    });
  });

  it('says the order moved on when the customer canceled first (409)', async () => {
    serverOrders = [preparing()];
    servePost(NEW_ORDER_ID, 'dispatch', () => {
      serverOrders = [];
      return HttpResponse.json(errorBody('ORDER_STATE_CONFLICT', { state: 'CANCELED' }), {
        status: 409,
      });
    });
    await renderDashboard('PREPARING');

    fireEvent.press(screen.getByTestId(`dispatch-${NEW_ORDER_ID}`));

    await waitFor(() => {
      expect(toast()?.message).toBe('This order has moved on.');
    });
    await waitFor(() => {
      expect(card()).not.toBeOnTheScreen();
    });
  });
});

describe('vendor dashboard: self-delivery handoff', () => {
  it('shows the code field and the cash to collect on a self-delivery order on the road', async () => {
    serverOrders = [onTheRoad()];

    await renderDashboard('READY');

    expect(codeInput()).toBeOnTheScreen();
    expect(screen.getByTestId(`delivery-cash-${NEW_ORDER_ID}`)).toHaveTextContent(
      'Collect Rs. 2400 in cash',
    );
    expect(screen.queryByTestId(`accept-${NEW_ORDER_ID}`)).not.toBeOnTheScreen();
  });

  it('never shows the code field on a fleet order', async () => {
    serverOrders = [onTheRoad({ fulfillment: 'PLATFORM_FLEET' })];

    // A fleet order waits under Ready for its rider, without the customer's code field.
    await renderDashboard('READY');
    expect(card()).toBeOnTheScreen();

    expect(codeInput()).not.toBeOnTheScreen();
  });

  it('formats the code: ASCII digits only, Nepali digits converted, at most 4', async () => {
    serverOrders = [onTheRoad()];
    await renderDashboard('READY');
    const input = screen.getByTestId(`delivery-otp-${NEW_ORDER_ID}`);

    fireEvent.changeText(input, '4a8 2');
    expect(input).toHaveDisplayValue('482');
    expect(screen.getByTestId(`deliver-${NEW_ORDER_ID}`)).toBeDisabled();

    fireEvent.changeText(input, '४८२१९');
    expect(input).toHaveDisplayValue('4821');
    expect(screen.getByTestId(`deliver-${NEW_ORDER_ID}`)).toBeEnabled();
  });

  it('delivers with the code and removes the order', async () => {
    serverOrders = [onTheRoad()];
    servePost(NEW_ORDER_ID, 'deliver', async () => {
      await delay(100);
      serverOrders = [];
      return HttpResponse.json(deliveryCompleted(NEW_ORDER_ID));
    });
    await renderDashboard('READY');

    fireEvent.changeText(screen.getByTestId(`delivery-otp-${NEW_ORDER_ID}`), '4821');
    fireEvent.press(screen.getByTestId(`deliver-${NEW_ORDER_ID}`));

    expect(await screen.findByText('Checking…')).toBeOnTheScreen();
    await waitFor(() => {
      expect(card()).not.toBeOnTheScreen();
    });
    expect(posts).toEqual([
      { path: `/api/vendors/orders/${NEW_ORDER_ID}/deliver`, body: { delivery_otp: '4821' } },
    ]);
    expect(toast()).toMatchObject({ message: 'Delivered. Thank you!', tone: 'success' });
    await showStage('HANDED_OVER');
    expect(card()).toBeOnTheScreen();
    expect(screen.getByText('Delivered.')).toBeOnTheScreen();
  });

  it('keeps the order on a wrong code, clears the field and shows the tries left', async () => {
    serverOrders = [onTheRoad()];
    servePost(NEW_ORDER_ID, 'deliver', () =>
      HttpResponse.json(errorBody('INVALID_OTP', { attempts_remaining: 2 }), { status: 401 }),
    );
    await renderDashboard('READY');

    fireEvent.changeText(screen.getByTestId(`delivery-otp-${NEW_ORDER_ID}`), '9999');
    fireEvent.press(screen.getByTestId(`deliver-${NEW_ORDER_ID}`));

    await waitFor(() => {
      expect(toast()).toMatchObject({ message: 'Wrong code. Attempts left: 2.', tone: 'error' });
    });
    expect(card()).toBeOnTheScreen();
    expect(screen.getByTestId(`delivery-otp-${NEW_ORDER_ID}`)).toHaveDisplayValue('');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(posts).toHaveLength(1);
  });

  it('explains the lockout in minutes', async () => {
    serverOrders = [onTheRoad()];
    servePost(NEW_ORDER_ID, 'deliver', () =>
      HttpResponse.json(errorBody('DELIVERY_OTP_LOCKED', { retry_after_seconds: 900 }), {
        status: 429,
      }),
    );
    await renderDashboard('READY');

    fireEvent.changeText(screen.getByTestId(`delivery-otp-${NEW_ORDER_ID}`), '1234');
    fireEvent.press(screen.getByTestId(`deliver-${NEW_ORDER_ID}`));

    await waitFor(() => {
      expect(toast()?.message).toBe('Too many wrong codes. Try again in 15 min.');
    });
    expect(card()).toBeOnTheScreen();
  });

  it('removes an order the server says is not the shop’s to hand over (409 WRONG_FULFILLMENT_MODE)', async () => {
    serverOrders = [onTheRoad()];
    servePost(NEW_ORDER_ID, 'deliver', () => {
      serverOrders = [];
      return HttpResponse.json(
        errorBody('WRONG_FULFILLMENT_MODE', { fulfillment: 'PLATFORM_FLEET' }),
        { status: 409 },
      );
    });
    await renderDashboard('READY');

    fireEvent.changeText(screen.getByTestId(`delivery-otp-${NEW_ORDER_ID}`), '1234');
    fireEvent.press(screen.getByTestId(`deliver-${NEW_ORDER_ID}`));

    await waitFor(() => {
      expect(card()).not.toBeOnTheScreen();
    });
    expect(toast()?.message).toBe("This order can't be delivered from here any more.");
  });

  it('keeps the alarm silent: an order on the road is not waiting for a decision', async () => {
    serverOrders = [onTheRoad()];

    await renderDashboard('READY');

    expect(screen.queryByTestId('vendor-alarm-banner')).not.toBeOnTheScreen();
  });
});
