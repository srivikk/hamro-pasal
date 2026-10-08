import { act, fireEvent, screen, waitFor, within } from '@testing-library/react-native';
import { router } from 'expo-router';
import { http, HttpResponse } from 'msw';

import CartScreen from '../../../app/cart';
import PaymentOptionsScreen from '../../../app/checkout/payment-options';
import { CHECKOUT_PATH } from '../../api/mutations';
import { useAuthStore } from '../../store/useAuthStore';
import { useCartStore } from '../../store/useCartStore';
import { useCheckoutStore } from '../../store/useCheckoutStore';
import { CART_QUOTE_PATH } from '../../api/cart-quote';
import {
  cartQuote,
  checkoutResponse,
  errorBody,
  NOODLES,
  RICE,
  THAMEL_VENDOR,
} from '../../test/api-fixtures';
import { apiUrl, server, setupApiTestEnvironment } from '../../test/msw';
import { renderWithProviders } from '../../test/render';
import { cartTotals } from '../cart/cart-totals';
import type * as MockPromotionsModule from '../promo/mock-promotions';
import type * as PromoModelModule from '../promo/promo-model';
import { usePaymentChoiceStore } from './payment-choice';

const mockRedirect = jest.fn();
jest.mock('expo-router', () => ({
  router: { push: jest.fn(), replace: jest.fn(), back: jest.fn() },
  Stack: { Screen: () => null },
  Redirect: ({ href }: { href: string }) => {
    mockRedirect(href);
    return null;
  },
}));
jest.mock('../promo/mock-promotions', () => {
  const actual = jest.requireActual<typeof MockPromotionsModule>('../promo/mock-promotions');
  const model = jest.requireActual<typeof PromoModelModule>('../promo/promo-model');
  return { ...actual, vendorExtras: jest.fn(() => model.NO_VENDOR_EXTRAS) };
});

setupApiTestEnvironment();

beforeEach(() => {
  jest.clearAllMocks();
  usePaymentChoiceStore.getState().clear();
});

const OFFER = { id: '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c51', label: '10% OFF', discount_npr: 115 };
/** The server's answer to POST /api/cart/quote for this test. */
const quoteIs = (body: () => object, status = 200): void => {
  server.use(http.post(apiUrl(CART_QUOTE_PATH), () => HttpResponse.json(body(), { status })));
};
/** The screen once the quote has answered. */
const paymentOptions = async (locale?: 'ne') => {
  const view = renderWithProviders(<PaymentOptionsScreen />, locale ? { locale } : undefined);
  await screen.findByTestId('payment-confirm');
  return view;
};

describe('cart totals shared by both checkout steps', () => {
  it('is the device’s estimate, with no discount, until the server has priced the cart', () => {
    const totals = cartTotals(THAMEL_VENDOR, [{ unitPriceNpr: 600, quantity: 2 }], undefined);

    expect(totals).toMatchObject({
      quoted: false,
      subtotalNpr: 1200,
      vendorOffer: null,
      platformPromo: null,
      deliveryFeeNpr: 50,
      savedNpr: 0,
      totalNpr: 1250,
    });
  });

  it('takes every figure from the quote: both discounts, the delivery charge and the total', () => {
    const totals = cartTotals(
      THAMEL_VENDOR,
      [{ unitPriceNpr: 500, quantity: 2 }],
      cartQuote({
        subtotal_npr: 1000,
        vendor_offer: { id: OFFER.id, label: 'Flat Rs. 100 OFF', discount_npr: 100 },
        platform_promo: { id: OFFER.id, label: 'Dashain 10%', discount_npr: 90 },
        delivery_fee_npr: 110,
        total_npr: 920,
      }),
    );

    expect(totals).toMatchObject({
      quoted: true,
      subtotalNpr: 1000,
      vendorOffer: { label: 'Flat Rs. 100 OFF', discountNpr: 100 },
      platformPromo: { label: 'Dashain 10%', discountNpr: 90 },
      deliveryFeeNpr: 110,
      savedNpr: 190,
      // The server's total, not a sum made on the device.
      totalNpr: 920,
    });
  });
});

describe('Payment Options screen (/checkout/payment-options)', () => {
  it('offers the methods of the quote, with the first available one chosen', async () => {
    useCartStore.getState().addItem(THAMEL_VENDOR, NOODLES, 2);
    renderWithProviders(<PaymentOptionsScreen />);
    // Nothing to choose from until the server has answered.
    expect(screen.getByTestId('payment-options-loading')).toBeOnTheScreen();
    await screen.findByTestId('payment-confirm');

    expect(
      screen.getAllByRole('radio').map((row) => row.props.accessibilityLabel as string),
    ).toEqual(['eSewa', 'Khalti', 'Cash on delivery']);
    expect(screen.getByRole('radio', { name: 'eSewa' })).toBeChecked();
    expect(screen.getByText('Pay in cash when your order arrives')).toBeOnTheScreen();
  });

  it('disables a method the quote does not offer, says why, and chooses the first that is', async () => {
    // A Model A shop: cash only (SPEC core 9, payment routing).
    quoteIs(() =>
      cartQuote({
        subtotal_npr: 1200,
        total_npr: 1250,
        payment_options: [
          { method: 'ESEWA', available: false, reason: 'SETTLEMENT_MODEL' },
          { method: 'KHALTI', available: false, reason: 'NOT_ACCEPTED_BY_SHOP' },
          { method: 'COD', available: true },
        ],
      }),
    );
    useCartStore.getState().addItem(THAMEL_VENDOR, NOODLES, 2);
    await paymentOptions();

    expect(screen.getByRole('radio', { name: 'eSewa' })).toBeDisabled();
    expect(screen.getByText('This shop takes cash on delivery only')).toBeOnTheScreen();
    expect(screen.getByText("This shop doesn't accept it")).toBeOnTheScreen();
    expect(screen.getByRole('radio', { name: 'Cash on delivery' })).toBeChecked();
    expect(screen.getByTestId('payment-confirm')).toHaveTextContent('Place Order • Rs. 1250');
  });

  it('offers no way to pay when the quote has none, and says so', async () => {
    quoteIs(() =>
      cartQuote({
        payment_options: [
          { method: 'ESEWA', available: false, reason: 'SETTLEMENT_MODEL' },
          { method: 'KHALTI', available: false, reason: 'SETTLEMENT_MODEL' },
          { method: 'COD', available: false, reason: 'COD_NOT_AVAILABLE' },
        ],
      }),
    );
    useCartStore.getState().addItem(THAMEL_VENDOR, NOODLES, 2);
    await paymentOptions();

    expect(screen.getByTestId('payment-none-available')).toBeOnTheScreen();
    expect(screen.getByTestId('payment-confirm')).toBeDisabled();
    expect(screen.getByText("Cash on delivery isn't available for your account")).toBeOnTheScreen();
  });

  it('shows the server’s discounted total, the same amount the cart showed', async () => {
    quoteIs(() => cartQuote({ subtotal_npr: 1150, vendor_offer: OFFER, total_npr: 1085 }));
    useCartStore.getState().addItem(THAMEL_VENDOR, RICE, 1);
    await paymentOptions();

    const amount = within(screen.getByTestId('payment-amount'));
    expect(amount.getByText('Rs. 1085')).toBeOnTheScreen();
    expect(amount.getByText('To pay for your order from Thamel Kirana Pasal')).toBeOnTheScreen();
    expect(amount.getByText('You save Rs. 115 on this order')).toBeOnTheScreen();
    expect(screen.getByTestId('payment-confirm')).toHaveTextContent('Pay Rs. 1085');
  });

  it('words the button for cash, and hands the method and the agreed total back to the cart', async () => {
    useCartStore.getState().addItem(THAMEL_VENDOR, NOODLES, 2);
    await paymentOptions();

    fireEvent.press(screen.getByRole('radio', { name: 'Cash on delivery' }));
    expect(screen.getByRole('radio', { name: 'Cash on delivery' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'eSewa' })).not.toBeChecked();
    expect(screen.getByTestId('payment-confirm')).toHaveTextContent('Place Order • Rs. 1250');
    // Choosing alone does nothing yet.
    expect(usePaymentChoiceStore.getState().chosen).toBeNull();
    expect(screen.queryByTestId('payment-processing')).toBeNull();

    jest.useFakeTimers();
    try {
      fireEvent.press(screen.getByTestId('payment-confirm'));

      // A full-screen veil for a second and a half; nothing is handed over before it ends.
      expect(screen.getByTestId('payment-processing')).toHaveTextContent('Processing…');
      expect(screen.getByTestId('payment-confirm')).toBeDisabled();
      act(() => {
        jest.advanceTimersByTime(1499);
      });
      expect(usePaymentChoiceStore.getState().chosen).toBeNull();
      expect(jest.mocked(router.back)).not.toHaveBeenCalled();

      act(() => {
        jest.advanceTimersByTime(1);
      });
      // The total on the button travels with the choice: checkout compares it.
      expect(usePaymentChoiceStore.getState().chosen).toEqual({
        method: 'COD',
        expectedTotalNpr: 1250,
      });
      expect(jest.mocked(router.back)).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('hands nothing over when the screen is left while the veil is up', async () => {
    useCartStore.getState().addItem(THAMEL_VENDOR, NOODLES, 2);
    const { unmount } = await paymentOptions();

    jest.useFakeTimers();
    try {
      fireEvent.press(screen.getByTestId('payment-confirm'));
      unmount();
      act(() => {
        jest.advanceTimersByTime(5000);
      });

      expect(usePaymentChoiceStore.getState().chosen).toBeNull();
      expect(jest.mocked(router.back)).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('goes back to the cart when there is nothing to pay for, or nobody signed in', () => {
    const { unmount } = renderWithProviders(<PaymentOptionsScreen />);
    expect(mockRedirect).toHaveBeenCalledWith('/cart');
    unmount();
    mockRedirect.mockClear();

    useCartStore.getState().addItem(THAMEL_VENDOR, NOODLES, 2);
    useAuthStore.getState().clearSession();
    renderWithProviders(<PaymentOptionsScreen />);
    expect(mockRedirect).toHaveBeenCalledWith('/cart');
    expect(screen.queryByTestId('payment-confirm')).toBeNull();
  });

  it('goes back to the cart, which explains, when the server refuses to price the cart', async () => {
    quoteIs(() => errorBody('VENDOR_UNAVAILABLE'), 422);
    useCartStore.getState().addItem(THAMEL_VENDOR, NOODLES, 2);
    renderWithProviders(<PaymentOptionsScreen />);

    await waitFor(() => {
      expect(mockRedirect).toHaveBeenCalledWith('/cart');
    });
    expect(screen.queryByTestId('payment-confirm')).toBeNull();
  });

  it('is in Nepali under ne', async () => {
    useCartStore.getState().addItem(THAMEL_VENDOR, NOODLES, 2);
    await paymentOptions('ne');

    expect(screen.getByTestId('payment-confirm')).toHaveTextContent('रु. १२५० तिर्नुहोस्');
  });
});

describe('the two steps together', () => {
  it('cart → Payment Options → the cart places the order with the chosen method and quoted total', async () => {
    quoteIs(() => cartQuote({ subtotal_npr: 1150, vendor_offer: OFFER, total_npr: 1085 }));
    const bodies: unknown[] = [];
    server.use(
      http.post(apiUrl(CHECKOUT_PATH), async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json(
          checkoutResponse({ order: { state: 'PLACED', payment_method: 'COD' }, otp: '3057' }),
          { status: 201 },
        );
      }),
    );
    useCartStore.getState().addItem(THAMEL_VENDOR, RICE, 1);
    // The cart stays mounted under the second screen, as it does under the stack in the app.
    renderWithProviders(
      <>
        <CartScreen />
        <PaymentOptionsScreen />
      </>,
    );
    await waitFor(() => {
      expect(screen.getByTestId('proceed-to-pay')).toHaveTextContent('Proceed to Pay • Rs. 1085');
    });

    fireEvent.press(screen.getByTestId('proceed-to-pay'));
    expect(jest.mocked(router.push)).toHaveBeenCalledWith('/checkout/payment-options');
    expect(bodies).toEqual([]);

    fireEvent.press(screen.getByRole('radio', { name: 'Cash on delivery' }));
    expect(screen.getByTestId('payment-confirm')).toHaveTextContent('Place Order • Rs. 1085');
    fireEvent.press(screen.getByTestId('payment-confirm'));

    await waitFor(() => {
      expect(bodies).toHaveLength(1);
    });
    // Ids, quantities and the total the customer agreed to; never a price per line or a discount.
    expect(bodies[0]).toMatchObject({
      payment_method: 'COD',
      items: [{ product_id: RICE.id, quantity: 1 }],
      expected_total_npr: 1085,
    });
    expect(Object.keys(bodies[0] as object).sort()).toEqual([
      'delivery_address',
      'expected_total_npr',
      'idempotency_key',
      'items',
      'payment_method',
      'vendor_id',
    ]);
    await waitFor(() => {
      expect(useCheckoutStore.getState().session?.orderState).toBe('PLACED');
    });
    // The choice was used once and is gone.
    expect(usePaymentChoiceStore.getState().chosen).toBeNull();
  });
});
