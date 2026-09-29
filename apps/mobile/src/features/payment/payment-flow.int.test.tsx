import type { PaymentStatusResponseBody } from '@hamro-pasal/shared-types';
import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import { http, HttpResponse } from 'msw';

import CartScreen from '../../../app/(tabs)/cart';
import { CHECKOUT_PATH } from '../../api/mutations';
import {
  ESEWA_INITIATE_PATH,
  ESEWA_WEBHOOK_PATH,
  KHALTI_INITIATE_PATH,
  KHALTI_LOOKUP_PATH,
} from '../../api/payments';
import { ToastHost } from '../../components/Toast';
import { useCartStore } from '../../store/useCartStore';
import { useCheckoutStore } from '../../store/useCheckoutStore';
import { useToastStore } from '../../store/useToastStore';
import {
  checkoutResponse,
  errorBody,
  ORDER_ID,
  RICE,
  THAMEL_VENDOR,
} from '../../test/api-fixtures';
import { mockWebView, navigateWebView, resetMockWebView } from '../../test/mock-webview';
import {
  apiUrl,
  capture,
  server,
  setupApiTestEnvironment,
  TEST_ACCESS_TOKEN,
  type CapturedRequest,
} from '../../test/msw';
import { renderWithProviders } from '../../test/render';

setupApiTestEnvironment();

const SUCCESS_URL = 'https://api.hamropasal.test/payments/esewa/success';
const FAILURE_URL = 'https://api.hamropasal.test/payments/esewa/failure';
const KHALTI_RETURN = 'https://api.hamropasal.test/payments/khalti/return';
const PIDX = 'bZQLD9wRVWo4CdESSfuSsB';
const ESEWA_DATA = 'eyJzdGF0dXMiOiJDT01QTEVURSJ9+abc/def==';

const placed: PaymentStatusResponseBody = {
  status: 'COMPLETE',
  payment: { order_id: ORDER_ID, order_state: 'PLACED', payment_status: 'PAID', duplicate: false },
};

interface Calls {
  checkout: CapturedRequest[];
  initiate: CapturedRequest[];
  confirm: CapturedRequest[];
}

function gateway(
  method: 'ESEWA' | 'KHALTI',
  confirmResponse: () => Response = () => HttpResponse.json(placed),
  initiateResponse?: () => Response,
): Calls {
  const calls: Calls = { checkout: [], initiate: [], confirm: [] };
  const inFuture = new Date(Date.now() + 600_000).toISOString();
  server.use(
    http.post(apiUrl(CHECKOUT_PATH), async ({ request }) => {
      calls.checkout.push(await capture(request));
      return HttpResponse.json(
        checkoutResponse({ order: { payment_method: method }, expiresAt: inFuture }),
        { status: 201 },
      );
    }),
    http.post(apiUrl(ESEWA_INITIATE_PATH), async ({ request }) => {
      calls.initiate.push(await capture(request));
      return (
        initiateResponse?.() ??
        HttpResponse.json({
          payment_url: 'https://rc-epay.esewa.com.np/api/epay/main/v2/form',
          method: 'POST',
          fields: {
            total_amount: '1200',
            transaction_uuid: `tx-${String(calls.initiate.length)}`,
            product_code: 'EPAYTEST',
            success_url: SUCCESS_URL,
            failure_url: FAILURE_URL,
            signed_field_names: 'total_amount,transaction_uuid,product_code',
            signature: 'c2lnbmF0dXJl',
          },
        })
      );
    }),
    http.post(apiUrl(KHALTI_INITIATE_PATH), async ({ request }) => {
      calls.initiate.push(await capture(request));
      return (
        initiateResponse?.() ??
        HttpResponse.json({
          pidx: PIDX,
          payment_url: `https://test-pay.khalti.com/?pidx=${PIDX}`,
          expires_at: null,
        })
      );
    }),
    http.post(apiUrl(ESEWA_WEBHOOK_PATH), async ({ request }) => {
      calls.confirm.push(await capture(request));
      return confirmResponse();
    }),
    http.post(apiUrl(KHALTI_LOOKUP_PATH), async ({ request }) => {
      calls.confirm.push(await capture(request));
      return confirmResponse();
    }),
  );
  return calls;
}

async function checkoutWith(method: 'ESEWA' | 'KHALTI') {
  useCartStore.getState().addItem(THAMEL_VENDOR, RICE, 1);
  renderWithProviders(
    <>
      <CartScreen />
      <ToastHost />
    </>,
  );
  fireEvent.press(screen.getByTestId(`payment-method-${method}`));
  fireEvent.press(screen.getByRole('button', { name: 'Proceed to Checkout' }));
  return screen.findByTestId('payment-webview');
}

const toastText = () => screen.getByTestId('toast');

beforeEach(() => {
  resetMockWebView();
  useToastStore.setState({ toast: null });
});

describe('eSewa payment', () => {
  it('opens the signed form after checkout, forwards the success data and places the order', async () => {
    const calls = gateway('ESEWA');

    await checkoutWith('ESEWA');

    // Initiate: authenticated, for the order the checkout just created.
    expect(calls.initiate).toHaveLength(1);
    expect(calls.initiate[0]?.body).toEqual({ order_id: ORDER_ID });
    expect(calls.initiate[0]?.headers.get('authorization')).toBe(`Bearer ${TEST_ACCESS_TOKEN}`);
    const source = mockWebView.props?.source as { html: string };
    expect(source.html).toContain('action="https://rc-epay.esewa.com.np/api/epay/main/v2/form"');
    expect(source.html).toContain('name="signature" value="c2lnbmF0dXJl"');

    navigateWebView(`${SUCCESS_URL}?data=${ESEWA_DATA}`);

    expect(screen.queryByTestId('payment-webview')).toBeNull();
    await waitFor(() => {
      expect(calls.confirm).toHaveLength(1);
    });
    // The signed payload reaches the server byte for byte.
    expect(calls.confirm[0]?.body).toEqual({ data: ESEWA_DATA });
    expect(await screen.findByText('Order placed!')).toBeOnTheScreen();
    expect(screen.getByText('Your delivery code: 4821')).toBeOnTheScreen();
    expect(toastText()).toHaveTextContent('Payment received. Your order is placed!');
    expect(useCartStore.getState().lines).toHaveLength(0);
  });

  it('closes on the failure redirect, shows a failure toast and allows a retry', async () => {
    const calls = gateway('ESEWA');
    await checkoutWith('ESEWA');

    navigateWebView(`${FAILURE_URL}?reason=cancelled`);

    expect(screen.queryByTestId('payment-webview')).toBeNull();
    expect(toastText()).toHaveTextContent(
      'Payment failed or was cancelled. Your items are still reserved, so you can try again.',
    );
    expect(calls.confirm).toHaveLength(0);
    expect(useCheckoutStore.getState().session?.orderState).toBe('PENDING_PAYMENT');

    fireEvent.press(screen.getByRole('button', { name: 'Pay with eSewa' }));
    expect(await screen.findByTestId('payment-webview')).toBeOnTheScreen();
    expect(calls.initiate).toHaveLength(2);
    expect((mockWebView.props?.source as { html: string }).html).toContain('value="tx-2"');
  });

  it('reports a payment that arrived after the reservation expired', async () => {
    gateway('ESEWA', () =>
      HttpResponse.json(
        errorBody('PAID_AFTER_SESSION_EXPIRED', { order_id: ORDER_ID, refund_required: true }),
        {
          status: 409,
        },
      ),
    );
    await checkoutWith('ESEWA');

    navigateWebView(`${SUCCESS_URL}?data=${ESEWA_DATA}`);

    expect(await screen.findByText('This order could not be completed.')).toBeOnTheScreen();
    expect(toastText()).toHaveTextContent(
      'Your payment arrived after the reservation expired. You will be refunded.',
    );
    expect(useCheckoutStore.getState().session?.orderState).toBe('FAILED');
  });

  it('shows a toast when the payment page cannot be opened', async () => {
    gateway('ESEWA', undefined, () =>
      HttpResponse.json(errorBody('PAYMENT_GATEWAY_ERROR'), { status: 502 }),
    );
    useCartStore.getState().addItem(THAMEL_VENDOR, RICE, 1);
    renderWithProviders(
      <>
        <CartScreen />
        <ToastHost />
      </>,
    );

    fireEvent.press(screen.getByRole('button', { name: 'Proceed to Checkout' }));

    expect(
      await screen.findByText("Couldn't open the payment page. Please try again."),
    ).toBeOnTheScreen();
    expect(screen.queryByTestId('payment-webview')).toBeNull();
    expect(screen.getByRole('button', { name: 'Pay with eSewa' })).toBeOnTheScreen();
  });

  it('shows a toast when the customer closes the payment page', async () => {
    const calls = gateway('ESEWA');
    await checkoutWith('ESEWA');

    fireEvent.press(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByTestId('payment-webview')).toBeNull();
    // Awaiting lets the list's deferred re-render (after the modal closes) settle inside the test.
    expect(await screen.findByTestId('toast')).toHaveTextContent(
      'Payment cancelled. Your items are still reserved until the timer runs out.',
    );
    expect(calls.confirm).toHaveLength(0);
  });
});

describe('Khalti payment', () => {
  it('loads payment_url, looks up the pidx on return and places the order', async () => {
    const calls = gateway('KHALTI', () => HttpResponse.json({ ...placed, status: 'Completed' }));

    await checkoutWith('KHALTI');

    expect(calls.initiate[0]?.body).toEqual({ order_id: ORDER_ID });
    expect(mockWebView.props?.source).toEqual({ uri: `https://test-pay.khalti.com/?pidx=${PIDX}` });

    navigateWebView(`${KHALTI_RETURN}?pidx=${PIDX}&status=Completed&transaction_id=abc`);

    expect(screen.queryByTestId('payment-webview')).toBeNull();
    await waitFor(() => {
      expect(calls.confirm).toHaveLength(1);
    });
    expect(calls.confirm[0]?.url.pathname).toBe('/api/payments/khalti/lookup');
    expect(calls.confirm[0]?.body).toEqual({ pidx: PIDX });
    expect(calls.confirm[0]?.headers.get('authorization')).toBe(`Bearer ${TEST_ACCESS_TOKEN}`);
    expect(await screen.findByText('Order placed!')).toBeOnTheScreen();
  });

  it('treats a cancelled return as a failure without a lookup', async () => {
    const calls = gateway('KHALTI');
    await checkoutWith('KHALTI');

    navigateWebView(`${KHALTI_RETURN}?pidx=${PIDX}&status=User%20canceled`);

    expect(screen.queryByTestId('payment-webview')).toBeNull();
    expect(toastText()).toHaveTextContent(
      'Payment failed or was cancelled. Your items are still reserved, so you can try again.',
    );
    expect(calls.confirm).toHaveLength(0);
  });

  it('keeps the reservation when the lookup reports the payment as not completed', async () => {
    gateway('KHALTI', () => HttpResponse.json({ status: 'Pending', payment: null }));
    await checkoutWith('KHALTI');

    navigateWebView(`${KHALTI_RETURN}?pidx=${PIDX}&status=Pending`);

    expect(
      await screen.findByText('Your payment is not complete yet. You can try again.'),
    ).toBeOnTheScreen();
    expect(useCheckoutStore.getState().session?.orderState).toBe('PENDING_PAYMENT');
    expect(screen.getByRole('button', { name: 'Pay with Khalti' })).toBeOnTheScreen();
  });
});

describe('cash on delivery', () => {
  it('never opens a payment page', async () => {
    const calls = gateway('ESEWA');
    server.use(
      http.post(apiUrl(CHECKOUT_PATH), () =>
        HttpResponse.json(checkoutResponse({ order: { state: 'PLACED', payment_method: 'COD' } }), {
          status: 201,
        }),
      ),
    );
    useCartStore.getState().addItem(THAMEL_VENDOR, RICE, 1);
    renderWithProviders(<CartScreen />);

    fireEvent.press(screen.getByTestId('payment-method-COD'));
    fireEvent.press(screen.getByRole('button', { name: 'Proceed to Checkout' }));

    expect(await screen.findByText('Order placed!')).toBeOnTheScreen();
    expect(calls.initiate).toHaveLength(0);
    expect(mockWebView.renders).toBe(0);
  });
});
