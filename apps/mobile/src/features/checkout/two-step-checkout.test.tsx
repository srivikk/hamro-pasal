import { act, fireEvent, screen, waitFor, within } from '@testing-library/react-native';
import { router } from 'expo-router';
import { http, HttpResponse } from 'msw';

import CartScreen from '../../../app/cart';
import PaymentOptionsScreen from '../../../app/checkout/payment-options';
import { CHECKOUT_PATH } from '../../api/mutations';
import { useAuthStore } from '../../store/useAuthStore';
import { useCartStore } from '../../store/useCartStore';
import { useCheckoutStore } from '../../store/useCheckoutStore';
import { checkoutResponse, NOODLES, RICE, THAMEL_VENDOR } from '../../test/api-fixtures';
import { apiUrl, server, setupApiTestEnvironment } from '../../test/msw';
import { renderWithProviders } from '../../test/render';
import { cartTotals } from '../cart/cart-totals';
import type * as MockPromotionsModule from '../promo/mock-promotions';
import { vendorExtras } from '../promo/mock-promotions';
import type * as PromoModelModule from '../promo/promo-model';
import { NO_VENDOR_EXTRAS } from '../promo/promo-model';
import { mockPaymentOptions, usePaymentChoiceStore } from './payment-choice';

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
  jest.mocked(vendorExtras).mockReturnValue(NO_VENDOR_EXTRAS);
});

describe('cart totals shared by both checkout steps', () => {
  it('is the plain estimate for a shop without a mock offer', () => {
    const totals = cartTotals(THAMEL_VENDOR, [{ unitPriceNpr: 600, quantity: 2 }]);

    expect(totals).toMatchObject({
      shopOffer: null,
      shopDiscountNpr: 0,
      displayedTotalNpr: 1250,
      summary: { subtotalNpr: 1200, deliveryFeeNpr: 50, totalNpr: 1250 },
    });
  });

  it('takes the demo discount off what is displayed, and nothing off the estimate itself', () => {
    jest.mocked(vendorExtras).mockReturnValue({ ...NO_VENDOR_EXTRAS, top_offer: '10% OFF' });

    const totals = cartTotals(THAMEL_VENDOR, [{ unitPriceNpr: 1150, quantity: 1 }]);

    expect(totals.shopDiscountNpr).toBe(115);
    expect(totals.displayedTotalNpr).toBe(1085);
    expect(totals.summary.totalNpr).toBe(1200);
  });
});

describe('Payment Options screen (/checkout/payment-options)', () => {
  it('offers the methods of the mock quote, with the first one chosen', () => {
    expect(mockPaymentOptions()).toEqual([
      { method: 'ESEWA', available: true },
      { method: 'KHALTI', available: true },
      { method: 'COD', available: true },
    ]);
    useCartStore.getState().addItem(THAMEL_VENDOR, NOODLES, 2);
    renderWithProviders(<PaymentOptionsScreen />);

    expect(
      screen.getAllByRole('radio').map((row) => row.props.accessibilityLabel as string),
    ).toEqual(['eSewa', 'Khalti', 'Cash on delivery']);
    expect(screen.getByRole('radio', { name: 'eSewa' })).toBeChecked();
    expect(screen.getByText('Pay in cash when your order arrives')).toBeOnTheScreen();
  });

  it('shows the amount the cart showed, demo discount included', () => {
    jest.mocked(vendorExtras).mockReturnValue({ ...NO_VENDOR_EXTRAS, top_offer: '10% OFF' });
    useCartStore.getState().addItem(THAMEL_VENDOR, RICE, 1);
    renderWithProviders(<PaymentOptionsScreen />);

    const amount = within(screen.getByTestId('payment-amount'));
    expect(amount.getByText('Rs. 1085')).toBeOnTheScreen();
    expect(amount.getByText('To pay for your order from Thamel Kirana Pasal')).toBeOnTheScreen();
    expect(amount.getByText('You save Rs. 115 on this order')).toBeOnTheScreen();
    expect(screen.getByTestId('payment-confirm')).toHaveTextContent('Pay Rs. 1085');
  });

  it('words the button for cash, and hands the chosen method back to the cart', () => {
    useCartStore.getState().addItem(THAMEL_VENDOR, NOODLES, 2);
    renderWithProviders(<PaymentOptionsScreen />);

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
      expect(usePaymentChoiceStore.getState().chosen).toBe('COD');
      expect(jest.mocked(router.back)).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('hands nothing over when the screen is left while the veil is up', () => {
    useCartStore.getState().addItem(THAMEL_VENDOR, NOODLES, 2);
    const { unmount } = renderWithProviders(<PaymentOptionsScreen />);

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

  it('is in Nepali under ne', () => {
    useCartStore.getState().addItem(THAMEL_VENDOR, NOODLES, 2);
    renderWithProviders(<PaymentOptionsScreen />, { locale: 'ne' });

    expect(screen.getByTestId('payment-confirm')).toHaveTextContent('रु. १२५० तिर्नुहोस्');
  });
});

describe('the two steps together', () => {
  it('cart → Payment Options → the cart places the order with the chosen method', async () => {
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

    fireEvent.press(screen.getByTestId('proceed-to-pay'));
    expect(jest.mocked(router.push)).toHaveBeenCalledWith('/checkout/payment-options');
    expect(bodies).toEqual([]);

    fireEvent.press(screen.getByRole('radio', { name: 'Cash on delivery' }));
    fireEvent.press(screen.getByTestId('payment-confirm'));

    await waitFor(() => {
      expect(bodies).toHaveLength(1);
    });
    expect(bodies[0]).toMatchObject({
      payment_method: 'COD',
      items: [{ product_id: RICE.id, quantity: 1 }],
    });
    await waitFor(() => {
      expect(useCheckoutStore.getState().session?.orderState).toBe('PLACED');
    });
    // The choice was used once and is gone.
    expect(usePaymentChoiceStore.getState().chosen).toBeNull();
  });
});
