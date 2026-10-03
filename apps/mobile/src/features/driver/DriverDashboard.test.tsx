import type { DeliveryView } from '@hamro-pasal/shared-types';
import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import { delay, http, HttpResponse } from 'msw';

import DriverDashboardScreen from '../../../app/(driver)/driver/dashboard';
import { DELIVERIES_PATH, deliveryPath, type DeliveryStep } from '../../api/deliveries';
import { useAuthStore } from '../../store/useAuthStore';
import { useToastStore } from '../../store/useToastStore';
import {
  acceptedDelivery,
  delivery,
  DELIVERY_ID,
  deliveryBody,
  deliveryCompleted,
  deliveryList,
  errorBody,
  NEW_ORDER_ID,
  pickedUpDelivery,
  SECOND_DELIVERY_ID,
  SECOND_ORDER_ID,
} from '../../test/api-fixtures';
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

/** What GET /api/deliveries answers right now (tests change it as the "server" moves on). */
let serverDeliveries: DeliveryView[] = [];
let listRequests = 0;
/** How long each GET /api/deliveries takes (a slow refetch shows what the cache patch did). */
let listDelayMs = 0;
/** delivery_otp of every POST …/complete, in order. */
let submitted: unknown[] = [];

function serveList(): void {
  server.use(
    http.get(apiUrl(DELIVERIES_PATH), async () => {
      listRequests += 1;
      if (listDelayMs > 0) await delay(listDelayMs);
      return HttpResponse.json(deliveryList(serverDeliveries));
    }),
  );
}

/** Serves POST …/accept or …/pickup; counts the requests. */
function serveStep(
  deliveryId: string,
  step: DeliveryStep,
  respond: () => Response | Promise<Response>,
): { requests: () => number } {
  let requests = 0;
  server.use(
    http.post(apiUrl(deliveryPath(deliveryId, step)), () => {
      requests += 1;
      return respond();
    }),
  );
  return { requests: () => requests };
}

/** Serves POST …/complete for the delivery; `respond` decides the answer. */
function serveComplete(deliveryId: string, respond: () => Response | Promise<Response>): void {
  server.use(
    http.post(apiUrl(deliveryPath(deliveryId, 'complete')), async ({ request }) => {
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

const card = (deliveryId = DELIVERY_ID) => screen.queryByTestId(`delivery-${deliveryId}`);
const stateOf = (deliveryId = DELIVERY_ID) => screen.getByTestId(`delivery-state-${deliveryId}`);
const acceptButton = (deliveryId = DELIVERY_ID) =>
  screen.getByTestId(`delivery-accept-${deliveryId}`);
const pickupButton = (deliveryId = DELIVERY_ID) =>
  screen.getByTestId(`delivery-pickup-${deliveryId}`);
const codeInput = (orderId = NEW_ORDER_ID) => screen.getByTestId(`delivery-otp-${orderId}`);
const completeButton = (orderId = NEW_ORDER_ID) => screen.getByTestId(`deliver-${orderId}`);
const toast = () => useToastStore.getState().toast;

function typeCode(text: string, orderId = NEW_ORDER_ID): void {
  fireEvent.changeText(codeInput(orderId), text);
}

beforeEach(() => {
  mockSocket = new FakeSocket();
  serverDeliveries = [pickedUpDelivery()];
  listRequests = 0;
  listDelayMs = 0;
  submitted = [];
  useAuthStore.getState().setLocale('en');
  useToastStore.setState({ toast: null });
  serveList();
});

describe('rider dashboard: the list', () => {
  it('shows each delivery with shop, address, items and cash to collect', async () => {
    serverDeliveries = [delivery()];

    await renderDashboard();

    expect(card()).toBeOnTheScreen();
    expect(screen.getByText('Pick up from Patan Organic Store')).toBeOnTheScreen();
    expect(screen.getByText('Ward 26, Thamel, Kathmandu Metropolitan City')).toBeOnTheScreen();
    expect(screen.getByText('2 × Wai Wai Noodles (carton of 30)')).toBeOnTheScreen();
    expect(screen.getByTestId(`delivery-cash-${NEW_ORDER_ID}`)).toHaveTextContent(
      'Collect Rs. 2400 in cash',
    );
    expect(stateOf()).toHaveTextContent('Open gig');
  });

  it('offers exactly the action of each state: Accept, Picked up, then the code field', async () => {
    serverDeliveries = [
      delivery(),
      acceptedDelivery({ id: SECOND_DELIVERY_ID, order: { id: SECOND_ORDER_ID } }),
    ];
    await renderDashboard();

    // An open gig: Accept only. No code can be typed before the parcel is picked up.
    expect(acceptButton()).toBeEnabled();
    expect(screen.queryByTestId(`delivery-pickup-${DELIVERY_ID}`)).not.toBeOnTheScreen();
    expect(screen.queryByTestId(`delivery-otp-${NEW_ORDER_ID}`)).not.toBeOnTheScreen();
    // Accepted: Picked up only.
    expect(stateOf(SECOND_DELIVERY_ID)).toHaveTextContent('Accepted');
    expect(pickupButton(SECOND_DELIVERY_ID)).toBeEnabled();
    expect(screen.queryByTestId(`delivery-accept-${SECOND_DELIVERY_ID}`)).not.toBeOnTheScreen();
    expect(screen.queryByTestId(`delivery-otp-${SECOND_ORDER_ID}`)).not.toBeOnTheScreen();
  });

  it('shows the code field once picked up', async () => {
    await renderDashboard();

    expect(stateOf()).toHaveTextContent('Picked up');
    expect(codeInput()).toBeOnTheScreen();
    expect(screen.queryByTestId(`delivery-accept-${DELIVERY_ID}`)).not.toBeOnTheScreen();
    expect(screen.queryByTestId(`delivery-pickup-${DELIVERY_ID}`)).not.toBeOnTheScreen();
  });

  it('tells the rider to collect nothing for a prepaid order', async () => {
    serverDeliveries = [delivery({ order: { payment_method: 'KHALTI', payment_status: 'PAID' } })];

    await renderDashboard();

    expect(screen.getByTestId(`delivery-cash-${NEW_ORDER_ID}`)).toHaveTextContent(
      'Paid online. Collect nothing.',
    );
  });

  it('shows the empty state when there is no delivery', async () => {
    serverDeliveries = [];

    await renderDashboard();

    expect(screen.getByTestId('driver-orders-empty')).toBeOnTheScreen();
  });

  it('offers a retry when the list cannot be loaded', async () => {
    server.use(
      http.get(apiUrl(DELIVERIES_PATH), () =>
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

describe('rider dashboard: accepting and picking up', () => {
  it('accepts an open gig: the card moves to Accepted and offers Picked up', async () => {
    serverDeliveries = [delivery()];
    const accept = serveStep(DELIVERY_ID, 'accept', async () => {
      await delay(100);
      serverDeliveries = [acceptedDelivery()];
      return HttpResponse.json(deliveryBody(acceptedDelivery()));
    });
    await renderDashboard();

    fireEvent.press(acceptButton());

    // In flight: the button says so and cannot be pressed twice.
    expect(await screen.findByText('Sending…')).toBeOnTheScreen();
    expect(acceptButton()).toBeDisabled();
    await waitFor(() => {
      expect(stateOf()).toHaveTextContent('Accepted');
    });
    expect(pickupButton()).toBeEnabled();
    expect(accept.requests()).toBe(1);
    expect(toast()).toMatchObject({
      message: 'Delivery accepted. Head to the shop.',
      tone: 'success',
    });
  });

  it('removes a gig another rider took first and says so', async () => {
    serverDeliveries = [delivery()];
    serveStep(DELIVERY_ID, 'accept', () =>
      HttpResponse.json(errorBody('DELIVERY_ALREADY_ASSIGNED'), { status: 409 }),
    );
    await renderDashboard();
    listDelayMs = 2_000; // the refetch has not answered when the card must already be gone

    fireEvent.press(acceptButton());

    await waitFor(() => {
      expect(card()).not.toBeOnTheScreen();
    });
    expect(listRequests).toBe(2);
    expect(toast()).toMatchObject({
      message: 'Another rider took this delivery.',
      tone: 'error',
    });
  });

  it('keeps the gig and the chance to retry when the network fails', async () => {
    serverDeliveries = [delivery()];
    const accept = serveStep(DELIVERY_ID, 'accept', () => HttpResponse.error());
    await renderDashboard();

    fireEvent.press(acceptButton());

    await waitFor(() => {
      expect(toast()?.message).toBe(
        "Couldn't update the delivery. Check your connection and try again.",
      );
    });
    expect(card()).toBeOnTheScreen();
    expect(acceptButton()).toBeEnabled();
    expect(accept.requests()).toBe(1); // never retried automatically
  });

  it('marks the parcel picked up: the code field appears', async () => {
    serverDeliveries = [acceptedDelivery()];
    serveStep(DELIVERY_ID, 'pickup', () => {
      serverDeliveries = [pickedUpDelivery()];
      return HttpResponse.json(deliveryBody(pickedUpDelivery()));
    });
    await renderDashboard();

    fireEvent.press(pickupButton());

    await waitFor(() => {
      expect(stateOf()).toHaveTextContent('Picked up');
    });
    expect(codeInput()).toBeOnTheScreen();
    expect(toast()?.message).toBe("Picked up. At the door, enter the customer's code.");
  });

  it('removes a delivery that is no longer this rider’s (404)', async () => {
    serverDeliveries = [acceptedDelivery()];
    serveStep(DELIVERY_ID, 'pickup', () => {
      serverDeliveries = [];
      return HttpResponse.json(errorBody('DELIVERY_NOT_FOUND'), { status: 404 });
    });
    await renderDashboard();

    fireEvent.press(pickupButton());

    await waitFor(() => {
      expect(card()).not.toBeOnTheScreen();
    });
    expect(toast()?.message).toBe("This order can't be delivered from here any more.");
  });

  it('refetches the list after a step', async () => {
    serverDeliveries = [delivery()];
    serveStep(DELIVERY_ID, 'accept', () => HttpResponse.json(deliveryBody(acceptedDelivery())));
    await renderDashboard();
    const before = listRequests;

    fireEvent.press(acceptButton());

    await waitFor(() => {
      expect(listRequests).toBe(before + 1);
    });
  });
});

describe('rider dashboard: the 4-digit code field', () => {
  it('keeps only ASCII digits, converts Nepali digits and stops at 4', async () => {
    await renderDashboard();

    typeCode('1a2 3');
    expect(codeInput()).toHaveDisplayValue('123');

    typeCode('१२३४५');
    expect(codeInput()).toHaveDisplayValue('1234');

    expect(codeInput().props).toMatchObject({ keyboardType: 'number-pad', maxLength: 4 });
  });

  it('enables Confirm delivery only once 4 digits are typed', async () => {
    serveComplete(DELIVERY_ID, () => HttpResponse.json(deliveryCompleted(NEW_ORDER_ID)));
    await renderDashboard();

    expect(completeButton()).toBeDisabled();
    typeCode('123');
    expect(completeButton()).toBeDisabled();
    fireEvent.press(completeButton());

    typeCode('1234');
    expect(completeButton()).toBeEnabled();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(submitted).toEqual([]); // the press on the 3-digit code sent nothing
  });

  it('keeps each delivery its own code', async () => {
    serverDeliveries = [
      pickedUpDelivery(),
      pickedUpDelivery({ id: SECOND_DELIVERY_ID, order: { id: SECOND_ORDER_ID } }),
    ];
    await renderDashboard();

    typeCode('1111', NEW_ORDER_ID);

    expect(codeInput(NEW_ORDER_ID)).toHaveDisplayValue('1111');
    expect(codeInput(SECOND_ORDER_ID)).toHaveDisplayValue('');
  });
});

describe('rider dashboard: completing with the doorstep code', () => {
  it('sends the code to the delivery, removes it at once and says so', async () => {
    serveComplete(DELIVERY_ID, async () => {
      await delay(100);
      serverDeliveries = [];
      return HttpResponse.json(deliveryCompleted(NEW_ORDER_ID));
    });
    await renderDashboard();

    typeCode('0421');
    fireEvent.press(completeButton());

    // In flight: the button says so and the code cannot be sent twice.
    expect(await screen.findByText('Checking…')).toBeOnTheScreen();
    expect(completeButton()).toBeDisabled();
    await waitFor(() => {
      expect(card()).not.toBeOnTheScreen();
    });
    expect(submitted).toEqual(['0421']);
    expect(toast()).toMatchObject({ message: 'Delivered. Thank you!', tone: 'success' });
  });

  it('keeps the delivery on a wrong code, clears the field and shows the tries left', async () => {
    serveComplete(DELIVERY_ID, () =>
      HttpResponse.json(errorBody('INVALID_OTP', { attempts_remaining: 3 }), { status: 401 }),
    );
    await renderDashboard();

    typeCode('9999');
    fireEvent.press(completeButton());

    await waitFor(() => {
      expect(toast()).toMatchObject({
        message: 'Wrong code. Attempts left: 3.',
        tone: 'error',
      });
    });
    expect(card()).toBeOnTheScreen();
    expect(codeInput()).toHaveDisplayValue('');
    expect(completeButton()).toBeDisabled();
    // Never retried: a second request would be a second wrong guess.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(submitted).toEqual(['9999']);
  });

  it('lets the rider try again after a wrong code', async () => {
    let answers = 0;
    serveComplete(DELIVERY_ID, () => {
      answers += 1;
      return answers === 1
        ? HttpResponse.json(errorBody('INVALID_OTP', { attempts_remaining: 4 }), { status: 401 })
        : HttpResponse.json(deliveryCompleted(NEW_ORDER_ID));
    });
    await renderDashboard();

    typeCode('9999');
    fireEvent.press(completeButton());
    await waitFor(() => {
      expect(codeInput()).toHaveDisplayValue('');
    });
    typeCode('0421');
    fireEvent.press(completeButton());

    await waitFor(() => {
      expect(toast()?.message).toBe('Delivered. Thank you!');
    });
    expect(submitted).toEqual(['9999', '0421']);
  });

  it('explains the lockout in minutes', async () => {
    serveComplete(DELIVERY_ID, () =>
      HttpResponse.json(errorBody('DELIVERY_OTP_LOCKED', { retry_after_seconds: 840 }), {
        status: 429,
      }),
    );
    await renderDashboard();

    typeCode('1234');
    fireEvent.press(completeButton());

    await waitFor(() => {
      expect(toast()).toMatchObject({
        message: 'Too many wrong codes. Try again in 14 min.',
        tone: 'error',
      });
    });
    expect(card()).toBeOnTheScreen();
  });

  it.each(['DELIVERY_NOT_FOUND', 'DELIVERY_STATE_CONFLICT', 'ORDER_STATE_CONFLICT'])(
    'removes a delivery that moved on (%s)',
    async (code) => {
      serveComplete(DELIVERY_ID, () => {
        serverDeliveries = [];
        return HttpResponse.json(errorBody(code), { status: code.endsWith('FOUND') ? 404 : 409 });
      });
      await renderDashboard();

      typeCode('1234');
      fireEvent.press(completeButton());

      await waitFor(() => {
        expect(card()).not.toBeOnTheScreen();
      });
      expect(toast()?.message).toBe("This order can't be delivered from here any more.");
    },
  );

  it('keeps the delivery and the chance to retry when the network fails', async () => {
    serveComplete(DELIVERY_ID, () => HttpResponse.error());
    await renderDashboard();

    typeCode('1234');
    fireEvent.press(completeButton());

    await waitFor(() => {
      expect(toast()?.message).toBe(
        "Couldn't confirm the delivery. Check your connection and try again.",
      );
    });
    expect(card()).toBeOnTheScreen();
    expect(submitted).toEqual(['1234']);
  });

  it('refetches the list after every answer', async () => {
    serveComplete(DELIVERY_ID, () =>
      HttpResponse.json(errorBody('INVALID_OTP', { attempts_remaining: 4 }), { status: 401 }),
    );
    await renderDashboard();
    const before = listRequests;

    typeCode('9999');
    fireEvent.press(completeButton());

    await waitFor(() => {
      expect(listRequests).toBe(before + 1);
    });
  });
});

describe('rider dashboard: the GPS simulation switch', () => {
  it('is off by default: no socket is opened', async () => {
    await renderDashboard();

    expect(screen.getByTestId('rider-gps-switch').props.value).toBe(false);
    expect(screen.getByTestId('rider-gps-status')).toHaveTextContent('Not sending a position.');
    expect(mockSocket.connectCalls).toBe(0);
  });

  it('streams a mock position over /orders once switched on, and stops when switched off', async () => {
    await renderDashboard();

    fireEvent(screen.getByTestId('rider-gps-switch'), 'valueChange', true);

    await waitFor(() => {
      expect(mockSocket.emittedOf('rider:location')).toHaveLength(1);
    });
    expect(mockSocket.url).toBe('http://api.hamropasal.test/orders');
    expect(mockSocket.emittedOf('rider:location')[0]).toEqual({
      latitude: 27.7154,
      longitude: 85.3123,
    });
    mockSocket.answerLast('rider:location', {
      ok: true,
      recorded_at: '2026-10-03T10:45:00.000Z',
    });
    expect(screen.getByTestId('rider-gps-status')).toHaveTextContent('Sending your position.');
    expect(screen.getByTestId('rider-gps-last')).toHaveTextContent(
      'Last sent: 27.71540, 85.31230 (reports: 1)',
    );

    fireEvent(screen.getByTestId('rider-gps-switch'), 'valueChange', false);

    expect(mockSocket.connected).toBe(false);
    expect(screen.getByTestId('rider-gps-status')).toHaveTextContent('Not sending a position.');
    expect(screen.queryByTestId('rider-gps-last')).not.toBeOnTheScreen();
  });
});
