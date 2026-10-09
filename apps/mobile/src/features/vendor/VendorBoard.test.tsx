import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { router } from 'expo-router';
import { http, HttpResponse } from 'msw';

import VendorDashboardScreen from '../../../app/(vendor)/dashboard';
import { VENDOR_ORDERS_PATH } from '../../api/vendor-orders';
import { useToastStore } from '../../store/useToastStore';
import { useVendorBoardStore } from '../../store/useVendorBoardStore';
import { useVendorShopStore } from '../../store/useVendorShopStore';
import { errorBody, NEW_ORDER_ID, vendorOrder, vendorOrderList } from '../../test/api-fixtures';
import { mockAudio, resetMockAudio } from '../../test/fake-audio';
import { FakeSocket } from '../../test/fake-socket';
import { apiUrl, server, setupApiTestEnvironment } from '../../test/msw';
import { createTestQueryClient, renderWithProviders } from '../../test/render';
import type { BoardStage } from './order-board';
import type * as VendorOrderMocksModule from './vendor-order-mocks';
import { buildMockOrder, MOCK_ORDER_INTERVAL_MS } from './vendor-order-mocks';

let mockSocket = new FakeSocket();
jest.mock('socket.io-client', () => ({
  io: (url: string, options: { auth?: unknown }) => mockSocket.created(url, options),
}));

jest.mock('expo-router', () => ({
  Stack: { Screen: () => null },
  router: { push: jest.fn(), replace: jest.fn() },
}));

// The board as a development build shows it: sample orders on (Jest turns them off by default).
jest.mock('./vendor-order-mocks', () => ({
  ...jest.requireActual<typeof VendorOrderMocksModule>('./vendor-order-mocks'),
  VENDOR_ORDER_MOCKS_ENABLED: true,
}));

setupApiTestEnvironment();

/** The seeded sample orders (their ids do not depend on the time). */
const SAMPLE_NEW = buildMockOrder(0, 0);
const SAMPLE_PREPARING = buildMockOrder(1, 0);
const SAMPLE_READY = buildMockOrder(3, 0);
const SAMPLE_WITH_RIDER = buildMockOrder(2, 0);

const card = (orderId: string) => screen.queryByTestId(`vendor-order-${orderId}`);
const count = (stage: BoardStage) => screen.getByTestId(`stage-count-${stage}`);
const showStage = (stage: BoardStage): void => {
  fireEvent.press(screen.getByTestId(`stage-${stage}`));
};
const toast = () => useToastStore.getState().toast;
const board = () => useVendorBoardStore.getState();

function serveLiveOrders(respond: () => Response): void {
  server.use(http.get(apiUrl(VENDOR_ORDERS_PATH), respond));
}

function expectCounts(counts: Record<BoardStage, number>): void {
  for (const [stage, value] of Object.entries(counts)) {
    expect(screen.getByTestId(`stage-count-${stage}`)).toHaveTextContent(String(value));
  }
}

beforeEach(() => {
  mockSocket = new FakeSocket();
  resetMockAudio();
  jest.mocked(router.push).mockClear();
  useToastStore.setState({ toast: null });
  useVendorBoardStore.getState().reset();
  useVendorShopStore.setState({ online: true, stored: null });
  serveLiveOrders(() => HttpResponse.json(vendorOrderList([])));
});

describe('vendor board with sample orders (development builds)', () => {
  it('opens on New with one sample order in every column', () => {
    renderWithProviders(<VendorDashboardScreen />);

    expectCounts({ NEW: 1, PREPARING: 1, READY: 1, HANDED_OVER: 1 });
    expect(card(SAMPLE_NEW.order.id)).toBeOnTheScreen();
    expect(card(SAMPLE_PREPARING.order.id)).not.toBeOnTheScreen();
    expect(screen.getByTestId('stage-NEW')).toBeSelected();
    expect(screen.getByTestId('vendor-order-list')).toBeOnTheScreen();
  });

  it('shows the order code, customer, items, time since placement and a SAMPLE tag', () => {
    renderWithProviders(<VendorDashboardScreen />);
    const id = SAMPLE_NEW.order.id;

    expect(
      screen.getByText(`Order #${id.replace(/-/g, '').slice(-6).toUpperCase()}`),
    ).toBeOnTheScreen();
    expect(screen.getByTestId(`order-customer-${id}`)).toHaveTextContent('Sita');
    expect(screen.getByTestId(`order-elapsed-${id}`)).toHaveTextContent('1 min ago');
    expect(screen.getByText('1 × Wai Wai Noodles (pack of 30)')).toBeOnTheScreen();
    expect(screen.getByText('SAMPLE')).toBeOnTheScreen();
    expect(screen.getByText('Accept Order')).toBeOnTheScreen();
  });

  it('filters by stage', () => {
    renderWithProviders(<VendorDashboardScreen />);

    showStage('PREPARING');
    expect(card(SAMPLE_PREPARING.order.id)).toBeOnTheScreen();
    expect(card(SAMPLE_NEW.order.id)).not.toBeOnTheScreen();
    expect(screen.getByTestId(`order-elapsed-${SAMPLE_PREPARING.order.id}`)).toHaveTextContent(
      '9 min ago',
    );
    expect(screen.getByText('Ready for Pickup')).toBeOnTheScreen();

    showStage('READY');
    expect(card(SAMPLE_READY.order.id)).toBeOnTheScreen();
    expect(screen.getByTestId(`delivery-otp-${SAMPLE_READY.order.id}`)).toBeOnTheScreen();

    showStage('HANDED_OVER');
    expect(card(SAMPLE_WITH_RIDER.order.id)).toBeOnTheScreen();
    expect(screen.getByText('Collected by a rider for delivery.')).toBeOnTheScreen();
  });

  it('pulses an unaccepted New order, in silence: a sample never rings the alarm', () => {
    renderWithProviders(<VendorDashboardScreen />);

    expect(screen.getByTestId(`order-pulse-${SAMPLE_NEW.order.id}`)).toBeOnTheScreen();
    expect(screen.queryByTestId('vendor-alarm-banner')).not.toBeOnTheScreen();
    expect(mockAudio.players.every((player) => player.play.mock.calls.length === 0)).toBe(true);

    showStage('PREPARING');
    expect(screen.queryByTestId(`order-pulse-${SAMPLE_PREPARING.order.id}`)).not.toBeOnTheScreen();
  });

  it('Accept Order moves a sample to Preparing on the device (no request is sent)', () => {
    renderWithProviders(<VendorDashboardScreen />);

    fireEvent.press(screen.getByTestId(`accept-${SAMPLE_NEW.order.id}`));

    expectCounts({ NEW: 0, PREPARING: 2, READY: 1, HANDED_OVER: 1 });
    expect(card(SAMPLE_NEW.order.id)).not.toBeOnTheScreen();
    expect(screen.getByTestId('vendor-stage-empty')).toBeOnTheScreen();
    // An unhandled request would have failed the mutation and said "Couldn't send your answer".
    expect(toast()).toMatchObject({
      message: 'Order accepted. Start preparing it.',
      tone: 'success',
    });
    showStage('PREPARING');
    expect(card(SAMPLE_NEW.order.id)).toBeOnTheScreen();
  });

  it('Reject removes a sample order', () => {
    renderWithProviders(<VendorDashboardScreen />);

    fireEvent.press(screen.getByTestId(`reject-${SAMPLE_NEW.order.id}`));

    expectCounts({ NEW: 0, PREPARING: 1, READY: 1, HANDED_OVER: 1 });
    expect(toast()?.message).toBe('Order rejected.');
  });

  it('Ready for Pickup moves own delivery to Ready, where any 4 digits hand it over', () => {
    renderWithProviders(<VendorDashboardScreen />);
    const id = SAMPLE_PREPARING.order.id;
    showStage('PREPARING');

    fireEvent.press(screen.getByTestId(`dispatch-${id}`));

    expectCounts({ NEW: 1, PREPARING: 0, READY: 2, HANDED_OVER: 1 });
    expect(toast()?.message).toBe('Order dispatched. Collect the code at the door.');

    showStage('READY');
    fireEvent.changeText(screen.getByTestId(`delivery-otp-${id}`), '1234');
    fireEvent.press(screen.getByTestId(`deliver-${id}`));

    expectCounts({ NEW: 1, PREPARING: 0, READY: 1, HANDED_OVER: 2 });
    expect(toast()?.message).toBe('Delivered. Thank you!');
    showStage('HANDED_OVER');
    expect(card(id)).toBeOnTheScreen();
    expect(screen.getByText('Delivered.')).toBeOnTheScreen();
  });

  it('Ready for Pickup puts a fleet order under Ready until its rider confirms the pickup', () => {
    const fleet = buildMockOrder(2, Date.now() - 120_000, 'PREPARING');
    const id = fleet.order.id;
    useVendorBoardStore.setState({ mocks: [fleet], mocksSeeded: true });
    renderWithProviders(<VendorDashboardScreen />);
    showStage('PREPARING');

    fireEvent.press(screen.getByTestId(`dispatch-${id}`));

    expectCounts({ NEW: 0, PREPARING: 0, READY: 1, HANDED_OVER: 0 });
    expect(toast()?.message).toBe('Order dispatched. A rider will deliver it.');
    showStage('READY');
    expect(screen.getByTestId(`order-rider-${id}`)).toHaveTextContent(
      'Riders have been told. Waiting for one to collect it.',
    );
    // A fleet order is the rider's to deliver: the shop never types the customer's code.
    expect(screen.queryByTestId(`delivery-otp-${id}`)).not.toBeOnTheScreen();

    fireEvent.press(screen.getByTestId(`rider-pickup-${id}`));

    expectCounts({ NEW: 0, PREPARING: 0, READY: 0, HANDED_OVER: 1 });
    showStage('HANDED_OVER');
    expect(screen.getByTestId(`order-rider-${id}`)).toHaveTextContent(
      'Collected by a rider for delivery.',
    );
    expect(screen.queryByTestId(`rider-pickup-${id}`)).not.toBeOnTheScreen();
  });

  it('a newly arrived order shows under New, pulsing, with the count in red until answered', () => {
    renderWithProviders(<VendorDashboardScreen />);
    fireEvent.press(screen.getByTestId(`accept-${SAMPLE_NEW.order.id}`));
    expect(count('NEW').props.className).not.toContain('bg-red-600');

    act(() => {
      board().addIncomingMock(Date.now());
    });

    const arrived = board().mocks.at(-1)?.order.id ?? '';
    expect(count('NEW')).toHaveTextContent('1');
    expect(count('NEW').props.className).toContain('bg-red-600');
    expect(screen.getByTestId(`order-pulse-${arrived}`)).toBeOnTheScreen();
    expect(screen.getByTestId(`order-elapsed-${arrived}`)).toHaveTextContent('Just now');
  });

  it('shows live orders beside the samples: a live one rings, has no name yet and no tag', async () => {
    serveLiveOrders(() => HttpResponse.json(vendorOrderList([vendorOrder()])));
    renderWithProviders(<VendorDashboardScreen />);

    await waitFor(() => {
      expect(count('NEW')).toHaveTextContent('2');
    });
    expect(screen.getByTestId('vendor-alarm-banner')).toBeOnTheScreen();
    expect(screen.getByTestId(`order-customer-${NEW_ORDER_ID}`)).toHaveTextContent('Customer');
    expect(screen.getAllByText('SAMPLE')).toHaveLength(1);
  });

  it('keeps the board usable when the live orders cannot be loaded', async () => {
    serveLiveOrders(() => HttpResponse.json(errorBody('VENDOR_NOT_FOUND'), { status: 404 }));
    renderWithProviders(<VendorDashboardScreen />);

    expect(await screen.findByTestId('vendor-live-unavailable')).toBeOnTheScreen();
    expect(card(SAMPLE_NEW.order.id)).toBeOnTheScreen();
    expect(screen.queryByTestId('vendor-orders-loading')).not.toBeOnTheScreen();
  });

  it('forgets the board when the dashboard closes (the vendor signed out)', () => {
    renderWithProviders(<VendorDashboardScreen />);
    expect(board().mocks).toHaveLength(4);

    screen.unmount();

    expect(board()).toMatchObject({ mocks: [], departed: [], mocksSeeded: false });
  });
});

describe('vendor board: sample orders arrive every 30 seconds while the shop is online', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('adds one per interval, stops while Offline and resumes when Online again', async () => {
    renderWithProviders(<VendorDashboardScreen />);
    expect(count('NEW')).toHaveTextContent('1');
    expect(screen.queryByTestId('vendor-offline-banner')).not.toBeOnTheScreen();

    await act(async () => {
      await jest.advanceTimersByTimeAsync(MOCK_ORDER_INTERVAL_MS);
    });
    expect(count('NEW')).toHaveTextContent('2');

    act(() => {
      useVendorShopStore.getState().setOnline(false);
    });
    expect(screen.getByTestId('vendor-offline-banner')).toBeOnTheScreen();
    await act(async () => {
      await jest.advanceTimersByTimeAsync(MOCK_ORDER_INTERVAL_MS * 3);
    });
    expect(count('NEW')).toHaveTextContent('2');

    act(() => {
      useVendorShopStore.getState().setOnline(true);
    });
    await act(async () => {
      await jest.advanceTimersByTimeAsync(MOCK_ORDER_INTERVAL_MS);
    });
    expect(count('NEW')).toHaveTextContent('3');
    expect(screen.queryByTestId('vendor-offline-banner')).not.toBeOnTheScreen();
  });
});

describe('vendor board: Ready for Pickup waits for the cancellation window', () => {
  const NOW = Date.parse('2026-10-07T06:00:00.000Z');

  beforeEach(() => {
    jest.useFakeTimers({ now: NOW });
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('is disabled with a countdown until 60 s after the order was placed, then enabled', async () => {
    const order = buildMockOrder(1, NOW - 20_000, 'PREPARING');
    const id = order.order.id;
    useVendorBoardStore.setState({ mocks: [order], mocksSeeded: true });
    renderWithProviders(<VendorDashboardScreen />);
    showStage('PREPARING');

    const button = () => screen.getByTestId(`dispatch-${id}`);
    expect(button()).toBeDisabled();
    expect(button()).toHaveTextContent('Ready for Pickup in 40 s');
    expect(screen.getByTestId(`dispatch-wait-${id}`)).toHaveTextContent(
      'The customer can still cancel this order.',
    );
    fireEvent.press(button());
    expect(count('PREPARING')).toHaveTextContent('1'); // a press does nothing yet

    await act(async () => {
      await jest.advanceTimersByTimeAsync(39_000);
    });
    expect(button()).toBeDisabled();
    expect(button()).toHaveTextContent('Ready for Pickup in 1 s');

    await act(async () => {
      await jest.advanceTimersByTimeAsync(1000);
    });
    expect(button()).toBeEnabled();
    expect(button()).toHaveTextContent('Ready for Pickup');
    expect(screen.queryByTestId(`dispatch-wait-${id}`)).not.toBeOnTheScreen();

    fireEvent.press(button());
    expect(count('READY')).toHaveTextContent('1');
  });

  it('is enabled at once for an order placed more than 60 s ago', () => {
    const order = buildMockOrder(1, NOW - 60_000, 'PREPARING');
    useVendorBoardStore.setState({ mocks: [order], mocksSeeded: true });
    renderWithProviders(<VendorDashboardScreen />);
    showStage('PREPARING');

    expect(screen.getByTestId(`dispatch-${order.order.id}`)).toBeEnabled();
  });

  it('counts down in Nepali digits under ne', () => {
    const order = buildMockOrder(1, NOW - 23_000, 'PREPARING');
    useVendorBoardStore.setState({ mocks: [order], mocksSeeded: true });
    renderWithProviders(<VendorDashboardScreen />, { locale: 'ne' });
    showStage('PREPARING');

    expect(screen.getByTestId(`dispatch-${order.order.id}`)).toHaveTextContent(/३७ सेकेन्ड/);
  });
});

describe('vendor board: the PAN reminder', () => {
  const identity = (overrides: Record<string, unknown>) => {
    server.use(
      http.get(apiUrl('/api/vendor/tax-identity'), () =>
        HttpResponse.json({
          vendor_id: '7b1f0c8e-0000-4000-8000-0000000000aa',
          tax_id: null,
          is_vat_registered: false,
          legal_name: null,
          registered_address: null,
          status: 'LIVE',
          pan_verified_at: null,
          has_pan_document: false,
          ...overrides,
        }),
      ),
    );
  };

  it('asks a shop the server holds no PAN for, and opens Shop settings', async () => {
    identity({});
    renderWithProviders(<VendorDashboardScreen />);
    // Nothing is claimed before the server has answered.
    expect(screen.queryByTestId('vendor-pan-banner')).not.toBeOnTheScreen();

    const banner = await screen.findByTestId('vendor-pan-banner');
    expect(banner).toHaveTextContent(/^Add your PAN to keep your shop visible/);
    fireEvent.press(banner);

    expect(router.push).toHaveBeenCalledWith('/settings');
  });

  it('asks for the certificate once the PAN is saved', async () => {
    identity({ tax_id: '302118845' });
    renderWithProviders(<VendorDashboardScreen />);

    expect(await screen.findByTestId('vendor-pan-banner')).toHaveTextContent(
      /^Upload your PAN certificate so your payouts can be released/,
    );
  });

  it('is gone once the PAN and its document are on file, whatever this phone once saved', async () => {
    identity({ tax_id: '302118845', has_pan_document: true });
    useVendorShopStore.setState({ stored: null });
    const queryClient = createTestQueryClient();
    renderWithProviders(<VendorDashboardScreen />, { queryClient });

    await waitFor(() => {
      expect(queryClient.getQueryData(['vendor', 'tax-identity'])).toBeDefined();
    });
    expect(screen.queryByTestId('vendor-pan-banner')).not.toBeOnTheScreen();
  });

  it('stays silent when the server cannot be asked', async () => {
    server.use(
      http.get(apiUrl('/api/vendor/tax-identity'), () =>
        HttpResponse.json({ error: { code: 'FORBIDDEN', message: 'no' } }, { status: 403 }),
      ),
    );
    const queryClient = createTestQueryClient();
    renderWithProviders(<VendorDashboardScreen />, { queryClient });

    await waitFor(() => {
      expect(queryClient.getQueryState(['vendor', 'tax-identity'])?.status).toBe('error');
    });
    expect(screen.queryByTestId('vendor-pan-banner')).not.toBeOnTheScreen();
  });
});
