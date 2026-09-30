import type { DriverOrderView } from '@hamro-pasal/shared-types';
import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import { delay, http, HttpResponse } from 'msw';

import DriverDashboardScreen from '../../../app/(driver)/driver/dashboard';
import { DRIVER_ORDERS_PATH, driverDeliverPath } from '../../api/driver-orders';
import { useAuthStore } from '../../store/useAuthStore';
import { useToastStore } from '../../store/useToastStore';
import {
  driverDelivered,
  driverOrder,
  driverOrderList,
  errorBody,
  NEW_ORDER_ID,
  SECOND_ORDER_ID,
} from '../../test/api-fixtures';
import { apiUrl, capture, server, setupApiTestEnvironment } from '../../test/msw';
import { renderWithProviders } from '../../test/render';

jest.mock('expo-router', () => ({
  Stack: { Screen: () => null },
  router: { push: jest.fn(), replace: jest.fn() },
}));

setupApiTestEnvironment();

/** What GET /api/driver/orders answers right now (tests change it as the "server" moves on). */
let serverOrders: DriverOrderView[] = [];
let listRequests = 0;
/** delivery_otp of every POST …/deliver, in order. */
let submitted: unknown[] = [];

function serveOrderList(): void {
  server.use(
    http.get(apiUrl(DRIVER_ORDERS_PATH), () => {
      listRequests += 1;
      return HttpResponse.json(driverOrderList(serverOrders));
    }),
  );
}

/** Serves POST …/deliver for the order; `respond` decides the answer. */
function serveDeliver(orderId: string, respond: () => Response | Promise<Response>): void {
  server.use(
    http.post(apiUrl(driverDeliverPath(orderId)), async ({ request }) => {
      submitted.push(((await capture(request)).body as { delivery_otp: unknown }).delivery_otp);
      return respond();
    }),
  );
}

async function renderDashboard(locale: 'en' | 'ne' = 'en'): Promise<void> {
  renderWithProviders(<DriverDashboardScreen />, { locale });
  await waitFor(() => {
    expect(screen.queryByTestId('driver-orders-loading')).not.toBeOnTheScreen();
  });
}

const card = (orderId: string) => screen.queryByTestId(`driver-order-${orderId}`);
const codeInput = (orderId = NEW_ORDER_ID) => screen.getByTestId(`delivery-otp-${orderId}`);
const deliverButton = (orderId = NEW_ORDER_ID) => screen.getByTestId(`deliver-${orderId}`);
const toast = () => useToastStore.getState().toast;

function typeCode(text: string, orderId = NEW_ORDER_ID): void {
  fireEvent.changeText(codeInput(orderId), text);
}

beforeEach(() => {
  serverOrders = [driverOrder()];
  listRequests = 0;
  submitted = [];
  useAuthStore.getState().setLocale('en');
  useToastStore.setState({ toast: null });
  serveOrderList();
});

describe('driver dashboard: the list', () => {
  it('shows each order out for delivery with shop, address, items and cash to collect', async () => {
    await renderDashboard();

    expect(card(NEW_ORDER_ID)).toBeOnTheScreen();
    expect(screen.getByText('Pick up from Patan Organic Store')).toBeOnTheScreen();
    expect(screen.getByText('Ward 26, Thamel, Kathmandu Metropolitan City')).toBeOnTheScreen();
    expect(screen.getByText('2 × Wai Wai Noodles (carton of 30)')).toBeOnTheScreen();
    expect(screen.getByTestId(`delivery-cash-${NEW_ORDER_ID}`)).toHaveTextContent(
      'Collect Rs. 2400 in cash',
    );
    expect(screen.getByText('Open gig')).toBeOnTheScreen();
  });

  it('tells the rider to collect nothing for a prepaid order', async () => {
    serverOrders = [driverOrder({ payment_method: 'KHALTI', payment_status: 'PAID' })];

    await renderDashboard();

    expect(screen.getByTestId(`delivery-cash-${NEW_ORDER_ID}`)).toHaveTextContent(
      'Paid online. Collect nothing.',
    );
  });

  it('shows the empty state when nothing is out for delivery', async () => {
    serverOrders = [];

    await renderDashboard();

    expect(screen.getByTestId('driver-orders-empty')).toBeOnTheScreen();
  });

  it('offers a retry when the list cannot be loaded', async () => {
    server.use(
      http.get(apiUrl(DRIVER_ORDERS_PATH), () =>
        HttpResponse.json(errorBody('FORBIDDEN'), { status: 403 }),
      ),
    );

    renderWithProviders(<DriverDashboardScreen />);

    expect(
      await screen.findByText("Couldn't load your deliveries. Check your connection."),
    ).toBeOnTheScreen();
  });

  it('renders Nepali digits under ne', async () => {
    await renderDashboard('ne');

    expect(screen.getByTestId(`delivery-cash-${NEW_ORDER_ID}`)).toHaveTextContent(
      'रु. २४०० नगद लिनुहोस्',
    );
  });
});

describe('driver dashboard: the 4-digit code field', () => {
  it('keeps only ASCII digits, converts Nepali digits and stops at 4', async () => {
    await renderDashboard();

    typeCode('1a2 3');
    expect(codeInput()).toHaveDisplayValue('123');

    typeCode('१२३४५');
    expect(codeInput()).toHaveDisplayValue('1234');

    expect(codeInput().props).toMatchObject({ keyboardType: 'number-pad', maxLength: 4 });
  });

  it('enables Confirm delivery only once 4 digits are typed', async () => {
    serveDeliver(NEW_ORDER_ID, () => HttpResponse.json(driverDelivered(NEW_ORDER_ID)));
    await renderDashboard();

    expect(deliverButton()).toBeDisabled();
    typeCode('123');
    expect(deliverButton()).toBeDisabled();
    fireEvent.press(deliverButton());

    typeCode('1234');
    expect(deliverButton()).toBeEnabled();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(submitted).toEqual([]); // the press on the 3-digit code sent nothing
  });

  it('keeps each order its own code', async () => {
    serverOrders = [driverOrder(), driverOrder({ id: SECOND_ORDER_ID })];
    await renderDashboard();

    typeCode('1111', NEW_ORDER_ID);

    expect(codeInput(NEW_ORDER_ID)).toHaveDisplayValue('1111');
    expect(codeInput(SECOND_ORDER_ID)).toHaveDisplayValue('');
  });
});

describe('driver dashboard: confirming the handoff (TanStack mutation)', () => {
  it('sends the code, removes the order at once and says so', async () => {
    serveDeliver(NEW_ORDER_ID, async () => {
      await delay(100);
      serverOrders = [];
      return HttpResponse.json(driverDelivered(NEW_ORDER_ID));
    });
    await renderDashboard();

    typeCode('0421');
    fireEvent.press(deliverButton());

    // In flight: the button says so and the code cannot be sent twice.
    expect(await screen.findByText('Checking…')).toBeOnTheScreen();
    expect(deliverButton()).toBeDisabled();
    await waitFor(() => {
      expect(card(NEW_ORDER_ID)).not.toBeOnTheScreen();
    });
    expect(submitted).toEqual(['0421']);
    expect(toast()).toMatchObject({ message: 'Delivered. Thank you!', tone: 'success' });
  });

  it('keeps the order on a wrong code, clears the field and shows the tries left', async () => {
    serveDeliver(NEW_ORDER_ID, () =>
      HttpResponse.json(errorBody('INVALID_OTP', { attempts_remaining: 3 }), { status: 401 }),
    );
    await renderDashboard();

    typeCode('9999');
    fireEvent.press(deliverButton());

    await waitFor(() => {
      expect(toast()).toMatchObject({
        message: 'Wrong code. Attempts left: 3.',
        tone: 'error',
      });
    });
    expect(card(NEW_ORDER_ID)).toBeOnTheScreen();
    expect(codeInput()).toHaveDisplayValue('');
    expect(deliverButton()).toBeDisabled();
    // Never retried: a second request would be a second wrong guess.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(submitted).toEqual(['9999']);
  });

  it('lets the rider try again after a wrong code', async () => {
    let answers = 0;
    serveDeliver(NEW_ORDER_ID, () => {
      answers += 1;
      return answers === 1
        ? HttpResponse.json(errorBody('INVALID_OTP', { attempts_remaining: 4 }), { status: 401 })
        : HttpResponse.json(driverDelivered(NEW_ORDER_ID));
    });
    await renderDashboard();

    typeCode('9999');
    fireEvent.press(deliverButton());
    await waitFor(() => {
      expect(codeInput()).toHaveDisplayValue('');
    });
    typeCode('0421');
    fireEvent.press(deliverButton());

    await waitFor(() => {
      expect(toast()?.message).toBe('Delivered. Thank you!');
    });
    expect(submitted).toEqual(['9999', '0421']);
  });

  it('explains the lockout in minutes', async () => {
    serveDeliver(NEW_ORDER_ID, () =>
      HttpResponse.json(errorBody('DELIVERY_OTP_LOCKED', { retry_after_seconds: 840 }), {
        status: 429,
      }),
    );
    await renderDashboard();

    typeCode('1234');
    fireEvent.press(deliverButton());

    await waitFor(() => {
      expect(toast()).toMatchObject({
        message: 'Too many wrong codes. Try again in 14 min.',
        tone: 'error',
      });
    });
    expect(card(NEW_ORDER_ID)).toBeOnTheScreen();
  });

  it('removes an order that is no longer this rider’s (409 / 404)', async () => {
    serveDeliver(NEW_ORDER_ID, () => {
      serverOrders = [];
      return HttpResponse.json(errorBody('ORDER_NOT_FOUND'), { status: 404 });
    });
    await renderDashboard();

    typeCode('1234');
    fireEvent.press(deliverButton());

    await waitFor(() => {
      expect(card(NEW_ORDER_ID)).not.toBeOnTheScreen();
    });
    expect(toast()?.message).toBe("This order can't be delivered from here any more.");
  });

  it('keeps the order and the chance to retry when the network fails', async () => {
    serveDeliver(NEW_ORDER_ID, () => HttpResponse.error());
    await renderDashboard();

    typeCode('1234');
    fireEvent.press(deliverButton());

    await waitFor(() => {
      expect(toast()?.message).toBe(
        "Couldn't confirm the delivery. Check your connection and try again.",
      );
    });
    expect(card(NEW_ORDER_ID)).toBeOnTheScreen();
    expect(submitted).toEqual(['1234']);
  });

  it('refetches the list after every answer', async () => {
    serveDeliver(NEW_ORDER_ID, () =>
      HttpResponse.json(errorBody('INVALID_OTP', { attempts_remaining: 4 }), { status: 401 }),
    );
    await renderDashboard();
    const before = listRequests;

    typeCode('9999');
    fireEvent.press(deliverButton());

    await waitFor(() => {
      expect(listRequests).toBe(before + 1);
    });
  });
});
