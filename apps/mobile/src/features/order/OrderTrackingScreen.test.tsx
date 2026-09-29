import type { OrderState } from '@hamro-pasal/shared-types';
import { act, fireEvent, screen } from '@testing-library/react-native';

import OrderTrackingScreen from '../../../app/order/[id]';
import { fetchOrder } from '../../api/orders';
import { useAuthStore } from '../../store/useAuthStore';
import { useDeliveryOtpStore } from '../../store/useDeliveryOtpStore';
import { useOrderStore } from '../../store/useOrderStore';
import { useToastStore } from '../../store/useToastStore';
import { ORDER_ID, orderView } from '../../test/api-fixtures';
import { renderWithProviders } from '../../test/render';

jest.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ id: '0b7e9c1a-2f4d-4c8e-9a6b-1d2e3f4a5b6c' }),
  Stack: { Screen: () => null },
  router: { push: jest.fn() },
}));

jest.mock('../../api/orders', () => ({ fetchOrder: jest.fn() }));
const mockFetchOrder = jest.mocked(fetchOrder);

const NOW = Date.parse('2026-09-29T10:00:00.000Z');

/** Advances fake time inside act, flushing the promises and timers it releases. */
async function advance(ms: number): Promise<void> {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(ms);
  });
}

function serverState(state: OrderState): void {
  mockFetchOrder.mockResolvedValue(orderView({ state, payment_method: 'COD', total_npr: 1250 }));
}

function placeOrder(placedAt: number | null, state: OrderState = 'PLACED'): void {
  useOrderStore.setState({
    orders: {
      [ORDER_ID]: { orderId: ORDER_ID, placedAt, state, paymentMethod: 'COD', totalNpr: 1250 },
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
  mockFetchOrder.mockReset();
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

  it('cancels the order when tapped inside the window', async () => {
    placeOrder(NOW);
    await renderScreen();
    await advance(20_000);

    fireEvent.press(screen.getByRole('button', { name: 'Cancel Order' }));
    await advance(0);
    expect(screen.getByRole('button', { name: 'Cancelling…' })).toBeDisabled();
    await advance(300); // mock cancel API latency

    expect(screen.getByText('Order cancelled')).toBeOnTheScreen();
    expect(useOrderStore.getState().orders[ORDER_ID]?.state).toBe('CANCELED');
    expect(useToastStore.getState().toast?.message).toBe('Your order was cancelled.');
    // A cancelled order has no handoff: the code is shown nowhere and erased from storage.
    expect(screen.queryByTestId('delivery-otp')).toBeNull();
    expect(useDeliveryOtpStore.getState().otps[ORDER_ID]).toBeUndefined();
    expect(screen.queryByTestId('cancellation-window')).toBeNull();
    expect(screen.queryByTestId('order-tracker')).toBeNull();
  });

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

  it('refuses a cancellation that reaches the server after the window closed', async () => {
    placeOrder(NOW);
    await renderScreen();
    await advance(59_900);

    fireEvent.press(screen.getByRole('button', { name: 'Cancel Order' }));
    await advance(300);

    expect(useOrderStore.getState().orders[ORDER_ID]?.state).toBe('PLACED');
    expect(useToastStore.getState().toast?.message).toBe(
      'The 60-second cancellation window has ended.',
    );
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
