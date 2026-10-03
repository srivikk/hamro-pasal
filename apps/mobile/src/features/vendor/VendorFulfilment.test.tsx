import type { VendorOrderView } from '@hamro-pasal/shared-types';
import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import { router } from 'expo-router';
import { delay, http, HttpResponse } from 'msw';

import VendorDashboardScreen from '../../../app/(vendor)/dashboard';
import { VENDOR_ORDERS_PATH, vendorOrderDecisionPath } from '../../api/vendor-orders';
import { useToastStore } from '../../store/useToastStore';
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

async function renderDashboard(): Promise<void> {
  renderWithProviders(<VendorDashboardScreen />);
  await waitFor(() => {
    expect(screen.queryByTestId('vendor-orders-loading')).not.toBeOnTheScreen();
  });
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
  serveOrderList();
});

describe('vendor dashboard: Dispatch', () => {
  it('offers Dispatch on PREPARING orders only', async () => {
    serverOrders = [vendorOrder(), preparing({ id: SECOND_ORDER_ID })];

    await renderDashboard();

    expect(dispatchButton(NEW_ORDER_ID)).not.toBeOnTheScreen(); // PLACED: Accept / Reject
    expect(dispatchButton(SECOND_ORDER_ID)).toBeOnTheScreen();
  });

  it('dispatches a self-delivery order, which moves to Out for delivery with the code field', async () => {
    serverOrders = [preparing()];
    servePost(NEW_ORDER_ID, 'dispatch', async () => {
      await delay(100);
      serverOrders = [onTheRoad()];
      return HttpResponse.json({ order_id: NEW_ORDER_ID, state: 'OUT_FOR_DELIVERY' });
    });
    await renderDashboard();
    expect(codeInput()).not.toBeOnTheScreen();

    fireEvent.press(screen.getByTestId(`dispatch-${NEW_ORDER_ID}`));

    expect(await screen.findByText('Dispatching…')).toBeOnTheScreen();
    await waitFor(() => {
      expect(codeInput()).toBeOnTheScreen();
    });
    expect(screen.getByText('Out for delivery')).toBeOnTheScreen();
    expect(dispatchButton()).not.toBeOnTheScreen();
    expect(posts).toEqual([
      { path: `/api/vendors/orders/${NEW_ORDER_ID}/dispatch`, body: undefined },
    ]);
    expect(toast()).toMatchObject({
      message: 'Order dispatched. Collect the code at the door.',
      tone: 'success',
    });
  });

  it('drops a dispatched fleet order from the list (the rider has it)', async () => {
    serverOrders = [preparing({ fulfillment: 'PLATFORM_FLEET' })];
    servePost(NEW_ORDER_ID, 'dispatch', () => {
      serverOrders = [];
      return HttpResponse.json({ order_id: NEW_ORDER_ID, state: 'OUT_FOR_DELIVERY' });
    });
    await renderDashboard();

    fireEvent.press(screen.getByTestId(`dispatch-${NEW_ORDER_ID}`));

    await waitFor(() => {
      expect(card()).not.toBeOnTheScreen();
    });
    expect(toast()?.message).toBe('Order dispatched. A rider will deliver it.');
  });

  it('explains 422 CANCELLATION_WINDOW_OPEN with the seconds left and keeps Dispatch', async () => {
    serverOrders = [preparing()];
    servePost(NEW_ORDER_ID, 'dispatch', () =>
      HttpResponse.json(errorBody('CANCELLATION_WINDOW_OPEN', { retry_after_seconds: 37 }), {
        status: 422,
      }),
    );
    await renderDashboard();

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
    await waitFor(() => {
      expect(dispatchButton()).toBeOnTheScreen();
    });

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
    await renderDashboard();

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

    await renderDashboard();

    expect(codeInput()).toBeOnTheScreen();
    expect(screen.getByTestId(`delivery-cash-${NEW_ORDER_ID}`)).toHaveTextContent(
      'Collect Rs. 2400 in cash',
    );
    expect(screen.queryByTestId(`accept-${NEW_ORDER_ID}`)).not.toBeOnTheScreen();
  });

  it('never shows the code field on a fleet order', async () => {
    serverOrders = [onTheRoad({ fulfillment: 'PLATFORM_FLEET' })];

    await renderDashboard();

    expect(codeInput()).not.toBeOnTheScreen();
  });

  it('formats the code: ASCII digits only, Nepali digits converted, at most 4', async () => {
    serverOrders = [onTheRoad()];
    await renderDashboard();
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
    await renderDashboard();

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
  });

  it('keeps the order on a wrong code, clears the field and shows the tries left', async () => {
    serverOrders = [onTheRoad()];
    servePost(NEW_ORDER_ID, 'deliver', () =>
      HttpResponse.json(errorBody('INVALID_OTP', { attempts_remaining: 2 }), { status: 401 }),
    );
    await renderDashboard();

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
    await renderDashboard();

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
    await renderDashboard();

    fireEvent.changeText(screen.getByTestId(`delivery-otp-${NEW_ORDER_ID}`), '1234');
    fireEvent.press(screen.getByTestId(`deliver-${NEW_ORDER_ID}`));

    await waitFor(() => {
      expect(card()).not.toBeOnTheScreen();
    });
    expect(toast()?.message).toBe("This order can't be delivered from here any more.");
  });

  it('keeps the alarm silent: an order on the road is not waiting for a decision', async () => {
    serverOrders = [onTheRoad()];

    await renderDashboard();

    expect(screen.queryByTestId('vendor-alarm-banner')).not.toBeOnTheScreen();
  });
});

describe('vendor dashboard: wallet', () => {
  it('opens the wallet screen (Phase 12)', async () => {
    jest.mocked(router.push).mockClear();
    await renderDashboard();

    fireEvent.press(screen.getByTestId('vendor-wallet-link'));

    expect(router.push).toHaveBeenCalledWith('/wallet');
  });
});
