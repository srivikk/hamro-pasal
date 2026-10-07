import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import { http, HttpResponse } from 'msw';
import { KeyboardAvoidingView, ScrollView } from 'react-native';

import CartScreen from '../../../app/cart';
import VerifyOtpScreen from '../../../app/verify-otp';
import { abandonCheckoutPath } from '../../api/abandon-checkout';
import { OTP_SEND_PATH, sendOtp } from '../../api/auth';
import { AddressFormModal } from '../../components/AddressFormModal';
import { useCartStore } from '../../store/useCartStore';
import { useCheckoutStore } from '../../store/useCheckoutStore';
import { useToastStore } from '../../store/useToastStore';
import {
  checkoutResponse,
  errorBody,
  NOODLES,
  otpSendResponse,
  TEST_PHONE,
  THAMEL_VENDOR,
} from '../../test/api-fixtures';
import { apiUrl, capture, server, setupApiTestEnvironment } from '../../test/msw';
import { renderWithProviders } from '../../test/render';

let mockParams: Record<string, string> = {};
jest.mock('expo-router', () => ({
  router: { push: jest.fn(), replace: jest.fn(), back: jest.fn(), canGoBack: jest.fn() },
  Stack: { Screen: () => null },
  Redirect: () => null,
  useLocalSearchParams: () => mockParams,
}));

setupApiTestEnvironment();

beforeEach(() => {
  useToastStore.setState({ toast: null });
});

describe('Cart: "Cancel Payment" unlocks a checkout that is waiting for payment', () => {
  /** A prepaid checkout waiting for payment: the cart is locked with the countdown running. */
  function lockCart(): string {
    useCartStore.getState().addItem(THAMEL_VENDOR, NOODLES, 2);
    useCheckoutStore
      .getState()
      .startSession(checkoutResponse({ expiresAt: new Date(Date.now() + 600_000).toISOString() }));
    const orderId = useCheckoutStore.getState().session?.orderId;
    if (orderId === undefined) throw new Error('No checkout session was started');
    return orderId;
  }
  function serveAbandon(orderId: string, respond: () => Response) {
    let calls = 0;
    server.use(
      http.post(apiUrl(abandonCheckoutPath(orderId)), () => {
        calls += 1;
        return respond();
      }),
    );
    return () => calls;
  }

  it('is offered only while the cart is locked', () => {
    useCartStore.getState().addItem(THAMEL_VENDOR, NOODLES, 2);
    renderWithProviders(<CartScreen />);

    expect(screen.queryByTestId('cancel-payment')).toBeNull();
  });

  it('asks the server to release the lock, ends the session and unlocks the cart', async () => {
    const orderId = lockCart();
    const calls = serveAbandon(orderId, () =>
      HttpResponse.json({ order_id: orderId, state: 'CANCELED' }),
    );
    renderWithProviders(<CartScreen />);
    expect(screen.queryByRole('button', { name: /^Proceed to Pay/ })).toBeNull();

    fireEvent.press(screen.getByRole('button', { name: 'Cancel Payment' }));

    await waitFor(() => {
      expect(useCheckoutStore.getState().session).toBeNull();
    });
    expect(calls()).toBe(1);
    // The items are still there, and the cart can be changed and checked out again.
    expect(useCartStore.getState().lines).toHaveLength(1);
    expect(await screen.findByRole('button', { name: /^Proceed to Pay/ })).toBeEnabled();
    expect(screen.getByRole('button', { name: `Add one ${NOODLES.name}` })).toBeEnabled();
    expect(useToastStore.getState().toast?.message).toBe(
      'Payment cancelled. You can change your cart again.',
    );
  });

  it.each([
    [
      'the route does not exist yet (404)',
      () => HttpResponse.json(errorBody('NOT_FOUND'), { status: 404 }),
    ],
    ['there is no connection', () => HttpResponse.error()],
  ])('still unlocks the cart on the phone when %s', async (_label, respond) => {
    const orderId = lockCart();
    serveAbandon(orderId, respond);
    renderWithProviders(<CartScreen />);

    fireEvent.press(screen.getByTestId('cancel-payment'));

    await waitFor(() => {
      expect(useCheckoutStore.getState().session).toBeNull();
    });
    expect(useCartStore.getState().lines).toHaveLength(1);
  });

  it('keeps the order when the payment had already gone through (409)', async () => {
    const orderId = lockCart();
    serveAbandon(orderId, () =>
      HttpResponse.json(errorBody('ORDER_STATE_CONFLICT'), { status: 409 }),
    );
    renderWithProviders(<CartScreen />);

    fireEvent.press(screen.getByTestId('cancel-payment'));

    await waitFor(() => {
      expect(useToastStore.getState().toast?.message).toBe(
        'Your payment already went through. Opening your order…',
      );
    });
    expect(useCheckoutStore.getState().session?.orderId).toBe(orderId);
  });
});

describe('OTP screen: "Get OTP via WhatsApp"', () => {
  function serveSend(respond: () => Response) {
    const bodies: unknown[] = [];
    server.use(
      http.post(apiUrl(OTP_SEND_PATH), async ({ request }) => {
        bodies.push((await capture(request)).body);
        return respond();
      }),
    );
    return bodies;
  }

  it('sends the channel only for WhatsApp, so the SMS request is unchanged', async () => {
    const bodies = serveSend(() => HttpResponse.json(otpSendResponse()));

    await sendOtp(TEST_PHONE);
    await sendOtp(TEST_PHONE, 'WHATSAPP');

    expect(bodies).toEqual([{ phone: TEST_PHONE }, { phone: TEST_PHONE, channel: 'WHATSAPP' }]);
  });

  it('requests the code on WhatsApp and restarts the resend countdown', async () => {
    mockParams = { phone: TEST_PHONE, resendAfter: '0' };
    const bodies = serveSend(() => HttpResponse.json(otpSendResponse()));
    renderWithProviders(<VerifyOtpScreen />);

    fireEvent.press(screen.getByRole('button', { name: 'Get OTP via WhatsApp' }));

    await waitFor(() => {
      expect(bodies).toEqual([{ phone: TEST_PHONE, channel: 'WHATSAPP' }]);
    });
    expect(await screen.findByTestId('resend-countdown')).toBeOnTheScreen();
    expect(useToastStore.getState().toast?.message).toBe('A new code is on its way on WhatsApp.');
    expect(screen.getByTestId('otp-whatsapp')).toBeDisabled();
  });

  it.each([
    [
      'a server that does not know the channel yet',
      () => HttpResponse.json(errorBody('VALIDATION_FAILED'), { status: 400 }),
    ],
    [
      'a server without a WhatsApp provider',
      () => HttpResponse.json(errorBody('OTP_CHANNEL_UNAVAILABLE'), { status: 503 }),
    ],
  ])('says WhatsApp is not available for %s', async (_label, respond) => {
    mockParams = { phone: TEST_PHONE, resendAfter: '0' };
    serveSend(respond);
    renderWithProviders(<VerifyOtpScreen />);

    fireEvent.press(screen.getByTestId('otp-whatsapp'));

    await waitFor(() => {
      expect(useToastStore.getState().toast?.message).toBe(
        "WhatsApp codes aren't available yet. Use the SMS code.",
      );
    });
  });

  it('waits out the resend cooldown like the SMS resend', () => {
    mockParams = { phone: TEST_PHONE, resendAfter: '60' };
    renderWithProviders(<VerifyOtpScreen />);

    expect(screen.getByTestId('otp-whatsapp')).toBeDisabled();
  });
});

describe('Address form and the keyboard', () => {
  it('sits in a keyboard-avoiding, scrollable container', () => {
    renderWithProviders(
      <AddressFormModal visible initial={null} onSave={jest.fn()} onClose={jest.fn()} />,
    );

    const container = screen.UNSAFE_getByType(KeyboardAvoidingView);
    expect(['padding', 'height']).toContain(container.props.behavior);
    expect(screen.UNSAFE_getByType(ScrollView).props.keyboardShouldPersistTaps).toBe('handled');
    expect(screen.getByTestId('address-landmark')).toBeOnTheScreen();
  });
});
