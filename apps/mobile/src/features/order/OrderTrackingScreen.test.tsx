import type { OrderState } from '@hamro-pasal/shared-types';
import { act, fireEvent, screen } from '@testing-library/react-native';
import { router } from 'expo-router';
import { delay, http, HttpResponse } from 'msw';

import OrderTrackingScreen from '../../../app/order/[id]';
import { cancelOrderPath, orderPath } from '../../api/orders';
import { useAuthStore } from '../../store/useAuthStore';
import { useDeliveryOtpStore } from '../../store/useDeliveryOtpStore';
import { useOrderStore } from '../../store/useOrderStore';
import { useToastStore } from '../../store/useToastStore';
import { cancelResponse, errorBody, ORDER_ID, orderDetailResponse } from '../../test/api-fixtures';
import { apiUrl, server, setupApiTestEnvironment } from '../../test/msw';
import { renderWithProviders } from '../../test/render';

jest.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ id: '0b7e9c1a-2f4d-4c8e-9a6b-1d2e3f4a5b6c' }),
  Stack: { Screen: () => null },
  router: { push: jest.fn() },
}));

const mockRouterPush = jest.mocked(router.push);

setupApiTestEnvironment();

/** Simulated server latency for POST /cancel, so the in-flight state can be observed. */
const CANCEL_LATENCY_MS = 300;

const NOW = Date.parse('2026-09-29T10:00:00.000Z');

/** Advances fake time inside act, flushing the promises and timers it releases. */
async function advance(ms: number): Promise<void> {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(ms);
  });
}

/** GET /api/orders/:id answers with this state (validated by orderDetailResponseSchema). */
function serverState(state: OrderState): void {
  server.use(
    http.get(apiUrl(orderPath(ORDER_ID)), () =>
      HttpResponse.json(orderDetailResponse({ state, payment_method: 'COD', total_npr: 1250 })),
    ),
  );
}

/** POST /api/orders/:id/cancel answers `respond()` after the simulated latency. */
function serveCancel(respond: () => Response): { calls: () => number } {
  let calls = 0;
  server.use(
    http.post(apiUrl(cancelOrderPath(ORDER_ID)), async () => {
      calls += 1;
      await delay(CANCEL_LATENCY_MS);
      return respond();
    }),
  );
  return { calls: () => calls };
}

function placeOrder(
  placedAt: number | null,
  state: OrderState = 'PLACED',
  deliveredAt: number | null = null,
): void {
  useOrderStore.setState({
    orders: {
      [ORDER_ID]: {
        orderId: ORDER_ID,
        placedAt,
        deliveredAt,
        state,
        paymentMethod: 'COD',
        totalNpr: 1250,
      },
    },
  });
}

async function renderScreen(locale: 'en' | 'ne' = 'en') {
  // Numbers follow the persisted preference, exactly as in the app (i18n is bound to it).
  useAuthStore.getState().setLocale(locale);
  renderWithProviders(<OrderTrackingScreen />, { locale });
  await advance(0);
}

const countdown = () => screen.getByTestId('cancellation-countdown');
const cancelButton = () => screen.queryByRole('button', { name: 'Cancel Order' });
const stepLabel = (label: string) => screen.getByLabelText(label);

beforeEach(() => {
  jest.useFakeTimers({ now: NOW });
  useAuthStore.getState().setLocale('en');
  useOrderStore.setState({ orders: {} });
  useDeliveryOtpStore.setState({ otps: { [ORDER_ID]: '4821' } });
  useToastStore.setState({ toast: null });
  serverState('PLACED');
});

afterEach(() => {
  jest.useRealTimers();
});

describe('60-second cancellation window', () => {
  it('counts down second by second from 60', async () => {
    placeOrder(NOW);
    await renderScreen();

    expect(countdown()).toHaveTextContent('You can cancel this order for 01:00');
    await advance(1000);
    expect(countdown()).toHaveTextContent('You can cancel this order for 00:59');
    await advance(29_000);
    expect(countdown()).toHaveTextContent('You can cancel this order for 00:30');
    await advance(29_000);
    expect(countdown()).toHaveTextContent('You can cancel this order for 00:01');
    expect(cancelButton()).toBeEnabled();
  });

  it('cancels the order through the API when tapped inside the window', async () => {
    const cancel = serveCancel(() => HttpResponse.json(cancelResponse()));
    placeOrder(NOW);
    await renderScreen();
    await advance(20_000);

    fireEvent.press(screen.getByRole('button', { name: 'Cancel Order' }));
    await advance(0);
    expect(screen.getByRole('button', { name: 'Cancelling…' })).toBeDisabled();
    await advance(CANCEL_LATENCY_MS);

    expect(cancel.calls()).toBe(1);
    expect(screen.getByText('Order cancelled')).toBeOnTheScreen();
    expect(useOrderStore.getState().orders[ORDER_ID]?.state).toBe('CANCELED');
    expect(useToastStore.getState().toast?.message).toBe('Your order was cancelled.');
    // A cancelled order has no handoff: the code is shown nowhere and erased from storage.
    expect(screen.queryByTestId('delivery-otp')).toBeNull();
    expect(useDeliveryOtpStore.getState().otps[ORDER_ID]).toBeUndefined();
    expect(screen.queryByTestId('cancellation-window')).toBeNull();
    expect(screen.queryByTestId('order-tracker')).toBeNull();
  });

  it.each([
    ['en', 'Order cancelled. Escrow refund initiated.'],
    ['ne', 'अर्डर रद्द भयो। रकम फिर्ता प्रक्रिया सुरु भयो।'],
  ] as const)(
    'tells the customer (%s) that a prepaid order is being refunded',
    async (locale, message) => {
      serveCancel(() => HttpResponse.json(cancelResponse(true)));
      placeOrder(NOW);
      await renderScreen(locale);

      fireEvent.press(
        screen.getByRole('button', {
          name: locale === 'en' ? 'Cancel Order' : 'अर्डर रद्द गर्नुहोस्',
        }),
      );
      await advance(CANCEL_LATENCY_MS);

      expect(useOrderStore.getState().orders[ORDER_ID]?.state).toBe('CANCELED');
      expect(useToastStore.getState().toast).toMatchObject({ message, tone: 'info' });
    },
  );

  it('removes cancellation and advances the tracker to Preparing when the timer hits 0', async () => {
    placeOrder(NOW);
    await renderScreen();
    expect(stepLabel('Order Placed: in progress')).toBeOnTheScreen();

    await advance(59_000);
    expect(cancelButton()).toBeOnTheScreen();

    await advance(1_000);
    expect(screen.queryByTestId('cancellation-window')).toBeNull();
    expect(cancelButton()).toBeNull();
    expect(stepLabel('Order Placed: done')).toBeOnTheScreen();
    expect(stepLabel('Preparing: in progress')).toBeOnTheScreen();
    // Display only: the stored server state is not rewritten.
    expect(useOrderStore.getState().orders[ORDER_ID]?.state).toBe('PLACED');
  });

  it('shows a toast when the server answers 422 CANCELLATION_WINDOW_EXPIRED', async () => {
    serveCancel(() => HttpResponse.json(errorBody('CANCELLATION_WINDOW_EXPIRED'), { status: 422 }));
    placeOrder(NOW);
    await renderScreen();
    await advance(59_900);

    fireEvent.press(screen.getByRole('button', { name: 'Cancel Order' }));
    await advance(CANCEL_LATENCY_MS);

    expect(useOrderStore.getState().orders[ORDER_ID]?.state).toBe('PLACED');
    expect(useToastStore.getState().toast).toMatchObject({
      message: 'The 60-second cancellation window has ended.',
      tone: 'error',
    });
    expect(cancelButton()).toBeNull();
  });

  it('shows the server state when it refuses for another reason (the vendor moved on)', async () => {
    serveCancel(() =>
      HttpResponse.json(errorBody('ORDER_STATE_CONFLICT', { state: 'PREPARING' }), {
        status: 409,
      }),
    );
    placeOrder(NOW);
    await renderScreen();
    serverState('PREPARING');

    fireEvent.press(screen.getByRole('button', { name: 'Cancel Order' }));
    await advance(CANCEL_LATENCY_MS);

    expect(useToastStore.getState().toast).toMatchObject({
      message: "Couldn't cancel the order. Please try again.",
      tone: 'error',
    });
    expect(useOrderStore.getState().orders[ORDER_ID]?.state).toBe('PREPARING');
    expect(cancelButton()).toBeNull();
  });

  it('resumes (never restarts) the window after the app is reopened', async () => {
    placeOrder(NOW - 45_000);
    await renderScreen();

    expect(countdown()).toHaveTextContent('You can cancel this order for 00:15');
    await advance(15_000);
    expect(cancelButton()).toBeNull();
  });

  it('offers no cancellation once the window has passed', async () => {
    placeOrder(NOW - 2 * 60_000);
    await renderScreen();

    expect(cancelButton()).toBeNull();
    expect(stepLabel('Preparing: in progress')).toBeOnTheScreen();
  });

  it('offers no cancellation when the placement time is unknown on this device', async () => {
    placeOrder(null);
    await renderScreen();

    expect(cancelButton()).toBeNull();
  });

  it('offers no cancellation for an order the vendor already moved on', async () => {
    placeOrder(NOW, 'PREPARING');
    serverState('PREPARING');
    await renderScreen();

    expect(cancelButton()).toBeNull();
  });
});

describe('discrete state tracker', () => {
  it.each([
    [
      'PREPARING',
      ['Order Placed: done'],
      ['Preparing: in progress'],
      ['Out for Delivery: upcoming', 'Arrived: upcoming', 'Delivered: upcoming'],
    ],
    [
      'OUT_FOR_DELIVERY',
      ['Order Placed: done', 'Preparing: done'],
      ['Out for Delivery: in progress'],
      ['Arrived: upcoming', 'Delivered: upcoming'],
    ],
    [
      'DELIVERED',
      [
        'Order Placed: done',
        'Preparing: done',
        'Out for Delivery: done',
        'Arrived: done',
        'Delivered: done',
      ],
      [],
      [],
    ],
  ] as const)('renders %s', async (state, completed, active, pending) => {
    placeOrder(NOW - 5 * 60_000, state);
    serverState(state);
    await renderScreen();

    for (const label of [...completed, ...active, ...pending]) {
      expect(stepLabel(label)).toBeOnTheScreen();
    }
    for (const label of completed) {
      expect(stepLabel(label)).not.toBeSelected();
      expect(stepLabel(label)).toBeEnabled();
    }
    for (const label of active) {
      expect(stepLabel(label)).toBeSelected();
      expect(stepLabel(label)).toBeEnabled();
    }
    for (const label of pending) {
      expect(stepLabel(label)).not.toBeSelected();
      expect(stepLabel(label)).toBeDisabled();
    }
  });

  it('follows the server state', async () => {
    placeOrder(NOW - 5 * 60_000);
    serverState('OUT_FOR_DELIVERY');
    await renderScreen();

    expect(stepLabel('Out for Delivery: in progress')).toBeOnTheScreen();
    expect(useOrderStore.getState().orders[ORDER_ID]?.state).toBe('OUT_FOR_DELIVERY');
  });

  it('hydrates an order this device has not tracked from the server', async () => {
    serverState('PREPARING');
    renderWithProviders(<OrderTrackingScreen />);
    expect(screen.getByTestId('order-loading')).toBeOnTheScreen();

    await advance(0);

    expect(stepLabel('Preparing: in progress')).toBeOnTheScreen();
    expect(cancelButton()).toBeNull();
  });

  it('labels the steps in Nepali', async () => {
    placeOrder(NOW - 5 * 60_000, 'OUT_FOR_DELIVERY');
    serverState('OUT_FOR_DELIVERY');
    await renderScreen('ne');

    expect(stepLabel('अर्डर गरियो: पूरा भयो')).toBeOnTheScreen();
    expect(stepLabel('डेलिभरीका लागि निस्कियो: हुँदैछ')).toBeOnTheScreen();
    expect(stepLabel('डेलिभर भयो: बाँकी')).toBeOnTheScreen();
  });
});

describe('dispute button (48 h after delivery)', () => {
  const MINUTE = 60_000;
  const HOUR = 60 * MINUTE;
  const disputeButton = () => screen.queryByRole('button', { name: 'Report an Issue / Dispute' });

  function delivered(ago: number): void {
    placeOrder(NOW - ago - HOUR, 'DELIVERED', NOW - ago);
    serverState('DELIVERED');
  }

  it('is shown at 47 h 59 min after delivery', async () => {
    delivered(47 * HOUR + 59 * MINUTE);
    await renderScreen();

    expect(disputeButton()).toBeOnTheScreen();
  });

  it('is hidden at 48 h 1 min after delivery', async () => {
    delivered(48 * HOUR + MINUTE);
    await renderScreen();

    expect(disputeButton()).toBeNull();
  });

  it('disappears on its own when the 48 h window closes while the screen is open', async () => {
    delivered(47 * HOUR + 59 * MINUTE);
    await renderScreen();
    expect(disputeButton()).toBeOnTheScreen();

    await advance(MINUTE - 1);
    expect(disputeButton()).toBeOnTheScreen();
    await advance(1);
    expect(disputeButton()).toBeNull();
  });

  it('opens the dispute chat for this order', async () => {
    delivered(HOUR);
    await renderScreen();

    fireEvent.press(screen.getByRole('button', { name: 'Report an Issue / Dispute' }));

    expect(mockRouterPush).toHaveBeenCalledWith({
      pathname: '/order/[id]/dispute',
      params: { id: ORDER_ID },
    });
  });

  it('is not offered before delivery, or when the delivery time is unknown', async () => {
    placeOrder(NOW - HOUR, 'OUT_FOR_DELIVERY');
    serverState('OUT_FOR_DELIVERY');
    await renderScreen();
    expect(disputeButton()).toBeNull();
  });

  it('is not offered when this device never saw the delivery time', async () => {
    placeOrder(NOW - HOUR, 'DELIVERED', null);
    serverState('DELIVERED');
    await renderScreen();
    expect(disputeButton()).toBeNull();
  });
});

describe('delivery OTP badge', () => {
  const digits = () =>
    screen.getAllByTestId('delivery-otp-digit').map((node) => node.props.children as string);

  it('shows the code with the handoff instruction', async () => {
    placeOrder(NOW);
    await renderScreen();

    expect(digits()).toEqual(['4', '8', '2', '1']);
    expect(screen.getByText('Share only with rider upon arrival.')).toBeOnTheScreen();
    expect(screen.getByLabelText('Delivery code 4 8 2 1')).toBeOnTheScreen();
  });

  it('uses Devanagari digits in Nepali and keeps leading zeros', async () => {
    useDeliveryOtpStore.setState({ otps: { [ORDER_ID]: '0427' } });
    placeOrder(NOW);
    await renderScreen('ne');

    expect(digits()).toEqual(['०', '४', '२', '७']);
    expect(screen.getByText('राइडर आइपुगेपछि मात्र यो कोड राइडरलाई दिनुहोस्।')).toBeOnTheScreen();
  });

  it('says so when the code is not on this device', async () => {
    useDeliveryOtpStore.setState({ otps: {} });
    placeOrder(NOW);
    await renderScreen();

    expect(
      screen.getByText("Your delivery code isn't available on this device."),
    ).toBeOnTheScreen();
  });

  it('is hidden and erased once the order is delivered', async () => {
    placeOrder(NOW - 5 * 60_000, 'OUT_FOR_DELIVERY');
    serverState('DELIVERED');
    await renderScreen();

    expect(screen.queryByTestId('delivery-otp')).toBeNull();
    expect(useDeliveryOtpStore.getState().otps[ORDER_ID]).toBeUndefined();
  });
});
