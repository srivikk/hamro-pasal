import { act, fireEvent, screen, waitFor, within } from '@testing-library/react-native';
import { router } from 'expo-router';
import { http, HttpResponse } from 'msw';
import { Alert } from 'react-native';

import CartScreen from '../../../app/cart';
import { CHECKOUT_PATH } from '../../api/mutations';
import { KHALTI_INITIATE_PATH } from '../../api/payments';
import { useAddressStore } from '../../store/useAddressStore';
import { useProfileStore } from '../../store/useProfileStore';
import { useAuthStore } from '../../store/useAuthStore';
import { useCartStore } from '../../store/useCartStore';
import { useCheckoutStore } from '../../store/useCheckoutStore';
import {
  checkoutResponse,
  errorBody,
  NOODLES,
  RICE,
  THAMEL_ADDRESS,
  THAMEL_VENDOR,
} from '../../test/api-fixtures';
import {
  apiUrl,
  capture,
  server,
  setupApiTestEnvironment,
  type CapturedRequest,
} from '../../test/msw';
import { payWith } from '../../test/pay-with';
import { renderWithProviders } from '../../test/render';
import { useTerritorySimulator } from '../territory/territory-simulator';
import type * as MockPromotionsModule from '../promo/mock-promotions';
import { vendorExtras } from '../promo/mock-promotions';
import type * as PromoModelModule from '../promo/promo-model';
import { NO_VENDOR_EXTRAS } from '../promo/promo-model';

jest.mock('expo-router', () => ({
  router: { push: jest.fn(), replace: jest.fn(), dismissTo: jest.fn() },
  Stack: { Screen: () => null },
}));
// The cart shows a mock "Shop Discount" for a shop with a mock offer. No offer unless a test says
// so, so every other total in this file is the real one (subtotal + delivery fee).
jest.mock('../promo/mock-promotions', () => {
  const actual = jest.requireActual<typeof MockPromotionsModule>('../promo/mock-promotions');
  const model = jest.requireActual<typeof PromoModelModule>('../promo/promo-model');
  return { ...actual, vendorExtras: jest.fn(() => model.NO_VENDOR_EXTRAS) };
});

setupApiTestEnvironment();

const TEA = {
  id: '7a2b3c40-0011-4000-8000-000000000003',
  name: 'Ilam Tea 500g',
  unitPriceNpr: 450,
};

function summaryRow(label: RegExp | string) {
  return within(screen.getByTestId('cart-summary')).getByText(label);
}

describe('Cart screen', () => {
  it('shows the empty state', () => {
    renderWithProviders(<CartScreen />);

    expect(screen.getByText('Your cart is empty')).toBeOnTheScreen();
  });

  it('summarises subtotal, delivery fee, platform fee and total', () => {
    useCartStore.getState().addItem(THAMEL_VENDOR, NOODLES, 2);
    renderWithProviders(<CartScreen />);

    expect(summaryRow('Subtotal · 2 items')).toBeOnTheScreen();
    expect(summaryRow('Rs. 1200')).toBeOnTheScreen();
    expect(summaryRow('Delivery fee')).toBeOnTheScreen();
    expect(summaryRow('Rs. 50')).toBeOnTheScreen();
    expect(summaryRow('Platform fee')).toBeOnTheScreen();
    expect(summaryRow('Rs. 0')).toBeOnTheScreen();
    expect(summaryRow('Total')).toBeOnTheScreen();
    expect(summaryRow('Rs. 1250')).toBeOnTheScreen();
  });

  it('updates quantities and totals with the +/- toggles', () => {
    useCartStore.getState().addItem(THAMEL_VENDOR, NOODLES, 1);
    renderWithProviders(<CartScreen />);

    fireEvent.press(screen.getByRole('button', { name: `Add one ${NOODLES.name}` }));
    expect(summaryRow('Rs. 1250')).toBeOnTheScreen();

    fireEvent.press(screen.getByRole('button', { name: `Remove one ${NOODLES.name}` }));
    fireEvent.press(screen.getByRole('button', { name: `Remove one ${NOODLES.name}` }));
    expect(screen.getByText('Your cart is empty')).toBeOnTheScreen();
  });

  it('requires a delivery address before checkout, then shows the saved one', async () => {
    useAddressStore.getState().clearAddress();
    useCartStore.getState().addItem(THAMEL_VENDOR, RICE, 1);
    renderWithProviders(<CartScreen />);

    expect(screen.getByText('Add a delivery address to continue.')).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: /^Proceed to Pay/ })).toBeDisabled();

    fireEvent.press(screen.getByRole('button', { name: 'Add delivery address' }));
    fireEvent.press(screen.getByTestId('address-province'));
    fireEvent.press(screen.getByText('3. Bagmati'));
    fireEvent.press(screen.getByTestId('address-district'));
    fireEvent.press(screen.getByText('Kathmandu'));
    fireEvent.changeText(screen.getByTestId('address-palika'), 'Kathmandu Metropolitan City');
    fireEvent.changeText(screen.getByTestId('address-ward'), '26');
    fireEvent.changeText(screen.getByTestId('address-tole'), 'Thamel');
    fireEvent.changeText(screen.getByTestId('address-landmark'), 'Near Kathmandu Guest House');
    // The pin stub reads the position through the __DEV__ simulator here (Kathmandu).
    useTerritorySimulator.setState({ simulation: 'inside' });
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Use my current location' }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    fireEvent.press(screen.getByRole('button', { name: 'Save address' }));
    useTerritorySimulator.setState({ simulation: 'off' });

    expect(screen.getByTestId('delivery-address-line')).toHaveTextContent(
      'Near Kathmandu Guest House, Thamel, Kathmandu Metropolitan City-26, Kathmandu',
    );
    expect(screen.queryByText('Add a delivery address to continue.')).toBeNull();
    expect(screen.getByRole('button', { name: /^Proceed to Pay/ })).toBeEnabled();
    expect(useAddressStore.getState().address?.ward_number).toBe(26);
  });

  it('blocks checkout below the vendor minimum order value (SPEC step 5)', () => {
    useCartStore.getState().addItem(THAMEL_VENDOR, TEA, 1);
    renderWithProviders(<CartScreen />);

    expect(
      screen.getByText("Add Rs. 50 more to reach this shop's minimum order."),
    ).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: /^Proceed to Pay/ })).toBeDisabled();
  });

  it('checks out with the chosen method, opens its payment page and freezes the cart', async () => {
    const received: CapturedRequest[] = [];
    server.use(
      http.post(apiUrl(KHALTI_INITIATE_PATH), () =>
        HttpResponse.json({
          pidx: 'bZQLD9wRVWo4CdESSfuSsB',
          payment_url: 'https://test-pay.khalti.com/?pidx=bZQLD9wRVWo4CdESSfuSsB',
          expires_at: null,
        }),
      ),
      http.post(apiUrl(CHECKOUT_PATH), async ({ request }) => {
        received.push(await capture(request));
        return HttpResponse.json(
          checkoutResponse({
            order: { payment_method: 'KHALTI' },
            expiresAt: new Date(Date.now() + 600_000).toISOString(),
          }),
          { status: 201 },
        );
      }),
    );
    useCartStore.getState().addItem(THAMEL_VENDOR, RICE, 1);
    renderWithProviders(<CartScreen />);

    payWith('KHALTI');

    // Prepaid: the gateway opens straight after the reservation is made (Phase 5.4).
    expect(await screen.findByTestId('payment-webview')).toBeOnTheScreen();
    expect(screen.getByTestId('reservation-countdown')).toBeOnTheScreen();
    expect(screen.getByText(/^Complete payment within (10:00|09:5\d)$/)).toBeOnTheScreen();
    expect(received).toHaveLength(1);
    expect(received[0]?.body).toMatchObject({
      payment_method: 'KHALTI',
      items: [{ product_id: RICE.id, quantity: 1 }],
    });
    expect(screen.getByRole('button', { name: `Add one ${RICE.name}` })).toBeDisabled();
    expect(screen.queryByRole('button', { name: /^Proceed to Pay/ })).toBeNull();
  });

  it('shows the delivery code once a COD order is placed', async () => {
    server.use(
      http.post(apiUrl(CHECKOUT_PATH), () =>
        HttpResponse.json(
          checkoutResponse({ order: { state: 'PLACED', payment_method: 'COD' }, otp: '3057' }),
          { status: 201 },
        ),
      ),
    );
    useCartStore.getState().addItem(THAMEL_VENDOR, RICE, 1);
    renderWithProviders(<CartScreen />);

    payWith('COD');

    expect(await screen.findByText('Order placed!')).toBeOnTheScreen();
    expect(screen.getByText('Your delivery code: 3057')).toBeOnTheScreen();
    expect(screen.getByText('Your cart is empty')).toBeOnTheScreen();

    fireEvent.press(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryByText('Order placed!')).toBeNull();
  });

  it('explains a refused checkout using the server error code', async () => {
    server.use(
      http.post(apiUrl(CHECKOUT_PATH), () =>
        HttpResponse.json(errorBody('COD_NOT_AVAILABLE'), { status: 422 }),
      ),
    );
    useCartStore.getState().addItem(THAMEL_VENDOR, RICE, 1);
    renderWithProviders(<CartScreen />);

    payWith('COD');

    expect(
      await screen.findByText(
        "Cash on delivery isn't available for your account. Choose eSewa or Khalti.",
      ),
    ).toBeOnTheScreen();
    expect(useCartStore.getState().lines).toHaveLength(1);
  });

  it('shows "Session Expired" after the reservation lapsed', () => {
    useCheckoutStore.setState({ sessionExpired: true });
    renderWithProviders(<CartScreen />);

    expect(screen.getByText('Session Expired')).toBeOnTheScreen();
    fireEvent.press(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryByText('Session Expired')).toBeNull();
  });
});

describe('Cart screen when signed out', () => {
  beforeEach(() => {
    jest.mocked(router.push).mockClear();
    useCartStore.getState().addItem(THAMEL_VENDOR, NOODLES, 1);
  });

  it('shows a guest only the items, the totals and "Sign in to Checkout"', () => {
    useAuthStore.getState().clearSession();
    renderWithProviders(<CartScreen />);

    expect(screen.getByText(NOODLES.name)).toBeOnTheScreen();
    expect(screen.getByTestId('cart-summary')).toBeOnTheScreen();
    // An address is saved on this phone, and it is not shown to a signed-out visitor.
    expect(useAddressStore.getState().address).not.toBeNull();
    expect(screen.queryByTestId('delivery-address')).toBeNull();
    expect(screen.queryByText('Deliver to')).toBeNull();
    expect(screen.queryByText('Payment method')).toBeNull();
    expect(screen.queryByTestId('proceed-to-pay')).toBeNull();
    expect(screen.queryByTestId('address-required')).toBeNull();
    expect(screen.getByRole('button', { name: 'Sign in to Checkout' })).toBeOnTheScreen();
  });

  it('shows the delivery address and the payment methods once signed in', () => {
    renderWithProviders(<CartScreen />);

    expect(screen.getByTestId('delivery-address')).toBeOnTheScreen();
    expect(screen.getByTestId('proceed-to-pay')).toBeOnTheScreen();
  });

  it('switches the delivery address in the address book, and removes one', () => {
    const friendId =
      useAddressStore.getState().saveAddress({
        label: 'OTHER',
        recipient: { name: 'Sita Gurung', phone: '+9779800000002' },
        address: {
          ...THAMEL_ADDRESS,
          district_string: 'Lalitpur',
          municipality_palika_string: 'Lalitpur Metropolitan City',
          ward_number: 16,
          tole_locality: 'Pulchowk',
        },
      }) ?? '';
    const homeId = useAddressStore.getState().addresses[0]?.id ?? '';
    renderWithProviders(<CartScreen />);
    // The address saved last is the one delivered to, with its recipient.
    expect(screen.getByTestId('delivery-address-line')).toHaveTextContent(/, Pulchowk, /);
    expect(screen.getByTestId('address-icon-OTHER')).toBeOnTheScreen();
    expect(screen.getByTestId(`address-recipient-${friendId}`)).toHaveTextContent(
      'For Sita Gurung · +977 9800000002',
    );

    fireEvent.press(screen.getByRole('button', { name: 'Change' }));
    fireEvent.press(screen.getByTestId(`address-select-${homeId}`));

    expect(useAddressStore.getState().selectedId).toBe(homeId);
    expect(screen.getByTestId('delivery-address-line')).toHaveTextContent(/, Thamel, /);
    expect(screen.getByTestId('address-icon-HOME')).toBeOnTheScreen();

    fireEvent.press(screen.getByRole('button', { name: 'Change' }));
    fireEvent.press(screen.getByTestId(`address-remove-${friendId}`));

    expect(useAddressStore.getState().addresses.map((entry) => entry.id)).toEqual([homeId]);
  });

  it('asks a signed-in customer without a profile to complete it before checkout', () => {
    useProfileStore.getState().clearProfile();
    renderWithProviders(<CartScreen />);

    expect(screen.queryByRole('button', { name: /^Proceed to Pay/ })).toBeNull();
    expect(screen.getByTestId('profile-required')).toBeOnTheScreen();
    fireEvent.press(screen.getByRole('button', { name: 'Complete your profile' }));

    expect(router.push).toHaveBeenCalledWith('/complete-profile');
  });

  it('does not accept a profile entered for another account on this phone', () => {
    useProfileStore
      .getState()
      .setProfile({ full_name: 'Someone Else', email: 'else@example.com' }, 'another-user-id');
    renderWithProviders(<CartScreen />);

    expect(screen.queryByRole('button', { name: /^Proceed to Pay/ })).toBeNull();
    expect(screen.getByTestId('profile-required')).toBeOnTheScreen();
  });

  it('replaces "Proceed to Checkout" with "Sign in to Checkout", which opens the login', () => {
    useAuthStore.getState().clearSession();
    renderWithProviders(<CartScreen />);

    expect(screen.queryByRole('button', { name: /^Proceed to Pay/ })).toBeNull();
    fireEvent.press(screen.getByRole('button', { name: 'Sign in to Checkout' }));

    expect(router.push).toHaveBeenCalledWith('/login');
  });

  it('counts a stored refresh token as signed in (the access token is renewed on demand)', () => {
    useAuthStore.getState().setSession({ accessToken: 'a.b.c', refreshToken: 'r.e.f' });
    useAuthStore.setState({ accessToken: null });
    renderWithProviders(<CartScreen />);

    expect(screen.getByRole('button', { name: /^Proceed to Pay/ })).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'Sign in to Checkout' })).toBeNull();
  });

  it('shows the Nepali label', () => {
    useAuthStore.getState().clearSession();
    renderWithProviders(<CartScreen />, { locale: 'ne' });

    expect(screen.getByRole('button', { name: 'चेकआउट गर्न साइन इन गर्नुहोस्' })).toBeOnTheScreen();
  });
});

describe('Cart screen: 409 INSUFFICIENT_STOCK (Phase 18)', () => {
  /** Refuses the first checkout for lack of stock, then accepts. */
  function shortOfStock(shortfalls: { productId: string; requested: number; available: number }[]) {
    const received: CapturedRequest[] = [];
    server.use(
      http.post(apiUrl(CHECKOUT_PATH), async ({ request }) => {
        received.push(await capture(request));
        return received.length === 1
          ? HttpResponse.json(errorBody('INSUFFICIENT_STOCK', { shortfalls }), { status: 409 })
          : HttpResponse.json(
              checkoutResponse({ order: { state: 'PLACED', payment_method: 'COD' } }),
              { status: 201 },
            );
      }),
    );
    return received;
  }

  async function checkoutWithCod() {
    payWith('COD');
    await screen.findByTestId('checkout-error');
  }

  it('highlights the short line, records its stock and asks for a lower quantity', async () => {
    shortOfStock([{ productId: RICE.id, requested: 5, available: 2 }]);
    useCartStore.getState().addItem(THAMEL_VENDOR, RICE, 5);
    useCartStore.getState().addItem(THAMEL_VENDOR, NOODLES, 1);
    renderWithProviders(<CartScreen />);

    await checkoutWithCod();

    expect(screen.getByTestId('checkout-error')).toHaveTextContent(
      'Some items no longer have enough stock. Reduce the quantity and try again.',
    );
    const notice = screen.getByTestId(`cart-line-stock-${RICE.id}`);
    expect(within(notice).getByText('Only 2 left in stock. Lower the quantity.')).toBeOnTheScreen();
    expect(screen.queryByTestId(`cart-line-stock-${NOODLES.id}`)).toBeNull();
    // The store knows the stock; the quantity is still the customer's to change.
    expect(useCartStore.getState().lines).toEqual([
      expect.objectContaining({ productId: RICE.id, quantity: 5, availableStock: 2 }),
      expect.objectContaining({ productId: NOODLES.id, quantity: 1, availableStock: null }),
    ]);
    expect(screen.getByRole('button', { name: /^Proceed to Pay/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: `Add one ${RICE.name}` })).toBeDisabled();
  });

  it('checks out again once the quantity is set to what is left', async () => {
    const received = shortOfStock([{ productId: RICE.id, requested: 5, available: 2 }]);
    useCartStore.getState().addItem(THAMEL_VENDOR, RICE, 5);
    renderWithProviders(<CartScreen />);
    await checkoutWithCod();

    fireEvent.press(screen.getByRole('button', { name: `Set ${RICE.name} to 2` }));

    expect(screen.queryByTestId(`cart-line-stock-${RICE.id}`)).toBeNull();
    expect(screen.queryByTestId('checkout-error')).toBeNull();
    expect(useCartStore.getState().lines[0]).toMatchObject({ quantity: 2, availableStock: 2 });
    // At the stock: no further increase.
    expect(screen.getByRole('button', { name: `Add one ${RICE.name}` })).toBeDisabled();

    payWith('ESEWA');
    expect(await screen.findByText('Order placed!')).toBeOnTheScreen();

    const bodies = received.map(
      (request) => request.body as { idempotency_key: string; items: unknown },
    );
    expect(bodies[1]?.items).toEqual([{ product_id: RICE.id, quantity: 2 }]);
    // A changed cart is a new attempt, not a replay of the refused one.
    expect(bodies[1]?.idempotency_key).not.toBe(bodies[0]?.idempotency_key);
  });

  it('keeps the line highlighted while it is stepped down, until it fits', () => {
    useCartStore.getState().addItem(THAMEL_VENDOR, RICE, 4);
    useCartStore.getState().syncStock([{ productId: RICE.id, available: 2 }]);
    renderWithProviders(<CartScreen />);

    // No refusal on screen (e.g. after a relaunch): the cart still says what to do.
    expect(screen.getByTestId('stock-required')).toHaveTextContent(
      'Lower the highlighted items to continue.',
    );
    fireEvent.press(screen.getByRole('button', { name: `Remove one ${RICE.name}` }));
    expect(screen.getByTestId(`cart-line-stock-${RICE.id}`)).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: /^Proceed to Pay/ })).toBeDisabled();

    fireEvent.press(screen.getByRole('button', { name: `Remove one ${RICE.name}` }));
    expect(screen.queryByTestId(`cart-line-stock-${RICE.id}`)).toBeNull();
    expect(screen.queryByTestId('stock-required')).toBeNull();
    expect(screen.getByRole('button', { name: /^Proceed to Pay/ })).toBeEnabled();
  });

  it('asks to remove a line whose product sold out', async () => {
    shortOfStock([{ productId: NOODLES.id, requested: 1, available: 0 }]);
    useCartStore.getState().addItem(THAMEL_VENDOR, RICE, 1);
    useCartStore.getState().addItem(THAMEL_VENDOR, NOODLES, 1);
    renderWithProviders(<CartScreen />);
    await checkoutWithCod();

    const notice = screen.getByTestId(`cart-line-stock-${NOODLES.id}`);
    expect(
      within(notice).getByText('Out of stock. Remove this item to continue.'),
    ).toBeOnTheScreen();

    fireEvent.press(screen.getByRole('button', { name: `Remove ${NOODLES.name}` }));

    expect(useCartStore.getState().lines.map((line) => line.productId)).toEqual([RICE.id]);
    expect(screen.getByRole('button', { name: /^Proceed to Pay/ })).toBeEnabled();
  });

  it('highlights every short line the server names', async () => {
    shortOfStock([
      { productId: RICE.id, requested: 3, available: 1 },
      { productId: NOODLES.id, requested: 4, available: 3 },
    ]);
    useCartStore.getState().addItem(THAMEL_VENDOR, RICE, 3);
    useCartStore.getState().addItem(THAMEL_VENDOR, NOODLES, 4);
    renderWithProviders(<CartScreen />);
    await checkoutWithCod();

    expect(screen.getByText('Only 1 left in stock. Lower the quantity.')).toBeOnTheScreen();
    expect(screen.getByText('Only 3 left in stock. Lower the quantity.')).toBeOnTheScreen();
  });

  it('shows only the message when the server names no lines', async () => {
    shortOfStock([]);
    useCartStore.getState().addItem(THAMEL_VENDOR, RICE, 1);
    renderWithProviders(<CartScreen />);
    await checkoutWithCod();

    expect(screen.queryByTestId(`cart-line-stock-${RICE.id}`)).toBeNull();
    expect(screen.getByRole('button', { name: /^Proceed to Pay/ })).toBeEnabled();
  });

  it('prompts in Nepali with Devanagari numerals', () => {
    useCartStore.getState().addItem(THAMEL_VENDOR, RICE, 4);
    useCartStore.getState().syncStock([{ productId: RICE.id, available: 2 }]);
    renderWithProviders(<CartScreen />, { locale: 'ne' });

    expect(screen.getByText('स्टकमा २ वटा मात्र बाँकी छन्। परिमाण घटाउनुहोस्।')).toBeOnTheScreen();
    expect(screen.getByText('२ वटा राख्नुहोस्')).toBeOnTheScreen();
  });
});

describe('Cart screen: mock shop discount (display only, until POST /api/cart/quote exists)', () => {
  const offer = (top_offer: string | null) => {
    jest.mocked(vendorExtras).mockReturnValue({ ...NO_VENDOR_EXTRAS, top_offer });
  };
  afterEach(() => {
    jest.mocked(vendorExtras).mockReturnValue(NO_VENDOR_EXTRAS);
  });
  const summary = () => within(screen.getByTestId('cart-summary'));

  it('shows a percentage offer as a green line between subtotal and delivery fee, and lowers the total', () => {
    offer('10% OFF');
    useCartStore.getState().addItem(THAMEL_VENDOR, RICE, 1);
    renderWithProviders(<CartScreen />);

    const line = within(screen.getByTestId('cart-shop-discount'));
    expect(line.getByText('Shop Discount · 10% OFF')).toBeOnTheScreen();
    expect(line.getByText('- Rs. 115')).toBeOnTheScreen();
    // 1150 - 115 + 50.
    expect(summary().getByText('Rs. 1085')).toBeOnTheScreen();
    expect(summary().getByText('Rs. 1150')).toBeOnTheScreen();

    const texts = summary()
      .getAllByText(/Subtotal|Shop Discount|Delivery fee/)
      .map((node) => String(node.props.children));
    expect(texts.map((label) => label.split(' · ')[0])).toEqual([
      'Subtotal',
      'Shop Discount',
      'Delivery fee',
    ]);
  });

  it('follows the cart as quantities change', () => {
    offer('10% OFF');
    useCartStore.getState().addItem(THAMEL_VENDOR, NOODLES, 1);
    renderWithProviders(<CartScreen />);
    expect(within(screen.getByTestId('cart-shop-discount')).getByText('- Rs. 60')).toBeTruthy();

    fireEvent.press(screen.getByRole('button', { name: `Add one ${NOODLES.name}` }));

    expect(within(screen.getByTestId('cart-shop-discount')).getByText('- Rs. 120')).toBeTruthy();
    expect(summary().getByText('Rs. 1130')).toBeOnTheScreen();
  });

  it('takes a flat offer off as its amount, never more than the subtotal', () => {
    offer('Flat Rs. 200 OFF');
    useCartStore.getState().addItem(THAMEL_VENDOR, NOODLES, 1);
    const { unmount } = renderWithProviders(<CartScreen />);

    expect(within(screen.getByTestId('cart-shop-discount')).getByText('- Rs. 200')).toBeTruthy();
    expect(summary().getByText('Rs. 450')).toBeOnTheScreen();
    unmount();

    useCartStore.getState().clearCart();
    useCartStore
      .getState()
      .addItem(THAMEL_VENDOR, { id: TEA.id, name: 'Lapsi Candy', unitPriceNpr: 150 }, 1);
    renderWithProviders(<CartScreen />);
    expect(within(screen.getByTestId('cart-shop-discount')).getByText('- Rs. 150')).toBeTruthy();
    // Only the delivery fee is left.
    expect(within(screen.getByTestId('cart-summary')).getAllByText('Rs. 50').length).toBe(2);
  });

  it.each([[null], ['Buy 1 Get 1'], ['Dashain Sale']])(
    'adds no line and changes no total for %s',
    (label) => {
      offer(label);
      useCartStore.getState().addItem(THAMEL_VENDOR, NOODLES, 2);
      renderWithProviders(<CartScreen />);

      expect(screen.queryByTestId('cart-shop-discount')).toBeNull();
      expect(summary().getByText('Rs. 1250')).toBeOnTheScreen();
    },
  );

  it.each([['Free delivery'], ['FREE DELIVERY above Rs. 500']])(
    'shows the delivery fee as free for "%s" and leaves it out of the total',
    (label) => {
      offer(label);
      useCartStore.getState().addItem(THAMEL_VENDOR, NOODLES, 2);
      renderWithProviders(<CartScreen />);

      const fee = within(screen.getByTestId('cart-delivery-fee'));
      expect(fee.getByText('FREE')).toBeOnTheScreen();
      expect(fee.getByText(`Delivery fee · ${label}`)).toBeOnTheScreen();
      expect(fee.queryByText('Rs. 50')).toBeNull();
      // Rs. 1200 of noodles and nothing else: the subtotal row and the total row.
      expect(summary().getAllByText('Rs. 1200').length).toBe(2);
      expect(screen.queryByTestId('cart-shop-discount')).toBeNull();
      expect(screen.getByTestId('proceed-to-pay')).toHaveTextContent('Proceed to Pay • Rs. 1200');
    },
  );

  it('charges the delivery fee in the bill when the offer does not waive it', () => {
    offer('10% OFF');
    useCartStore.getState().addItem(THAMEL_VENDOR, NOODLES, 2);
    renderWithProviders(<CartScreen />);

    const fee = within(screen.getByTestId('cart-delivery-fee'));
    expect(fee.getByText('Rs. 50')).toBeOnTheScreen();
    expect(fee.queryByText('FREE')).toBeNull();
  });

  it('still measures the minimum order on the subtotal before the discount', () => {
    offer('10% OFF');
    // Thamel's minimum is Rs. 500: Rs. 450 of tea is short by 50, discount or not.
    useCartStore.getState().addItem(THAMEL_VENDOR, TEA, 1);
    renderWithProviders(<CartScreen />);

    expect(screen.getByTestId('cart-shop-discount')).toBeOnTheScreen();
    expect(
      screen.getByText("Add Rs. 50 more to reach this shop's minimum order."),
    ).toBeOnTheScreen();
  });

  it('writes the line in Nepali with Devanagari digits', () => {
    offer('10% OFF');
    useCartStore.getState().addItem(THAMEL_VENDOR, RICE, 1);
    renderWithProviders(<CartScreen />, { locale: 'ne' });

    const line = within(screen.getByTestId('cart-shop-discount'));
    expect(line.getByText('- रु. ११५')).toBeOnTheScreen();
    expect(line.getByText('पसलको छुट · 10% OFF')).toBeOnTheScreen();
  });
});

describe('Cart screen: Clear cart asks first, in the app’s own dialog', () => {
  let alert: jest.SpyInstance;
  beforeEach(() => {
    alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    useCartStore.getState().addItem(THAMEL_VENDOR, NOODLES, 2);
    useCartStore.getState().addItem(THAMEL_VENDOR, RICE, 1);
  });
  afterEach(() => {
    alert.mockRestore();
  });

  it('shows a themed confirmation, not the system alert, and removes nothing yet', () => {
    renderWithProviders(<CartScreen />);
    expect(screen.queryByTestId('clear-cart-modal')).toBeNull();

    fireEvent.press(screen.getByRole('button', { name: 'Clear cart' }));

    const dialog = within(screen.getByTestId('clear-cart-modal'));
    expect(dialog.getByText('Clear Cart?')).toBeOnTheScreen();
    expect(dialog.getByText('Are you sure you want to remove all items?')).toBeOnTheScreen();
    expect(dialog.getByRole('button', { name: 'Cancel' })).toBeOnTheScreen();
    expect(dialog.getByRole('button', { name: 'Yes, Clear' })).toBeOnTheScreen();
    expect(alert).not.toHaveBeenCalled();
    expect(useCartStore.getState().lines).toHaveLength(2);
  });

  it('keeps the cart when the customer cancels, from the button or the backdrop', async () => {
    renderWithProviders(<CartScreen />);

    fireEvent.press(screen.getByRole('button', { name: 'Clear cart' }));
    fireEvent.press(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => {
      expect(screen.queryByTestId('clear-cart-modal')).toBeNull();
    });

    fireEvent.press(screen.getByRole('button', { name: 'Clear cart' }));
    fireEvent.press(screen.getByTestId('clear-cart-modal-backdrop'));
    await waitFor(() => {
      expect(screen.queryByTestId('clear-cart-modal')).toBeNull();
    });

    expect(useCartStore.getState().lines).toHaveLength(2);
    expect(useCartStore.getState().vendor?.id).toBe(THAMEL_VENDOR.id);
  });

  it('empties the cart with "Yes, Clear"', () => {
    renderWithProviders(<CartScreen />);
    fireEvent.press(screen.getByRole('button', { name: 'Clear cart' }));

    fireEvent.press(screen.getByRole('button', { name: 'Yes, Clear' }));

    expect(useCartStore.getState().lines).toEqual([]);
    expect(useCartStore.getState().vendor).toBeNull();
    expect(screen.getByText('Your cart is empty')).toBeOnTheScreen();
  });
});

describe('Cart screen: two-step checkout', () => {
  beforeEach(() => {
    jest.mocked(router.push).mockClear();
  });

  it('shows one button with the amount to pay, which opens Payment Options', () => {
    useCartStore.getState().addItem(THAMEL_VENDOR, NOODLES, 2);
    renderWithProviders(<CartScreen />);

    const proceed = screen.getByTestId('proceed-to-pay');
    expect(proceed).toHaveTextContent('Proceed to Pay • Rs. 1250');
    // No payment method is chosen in the cart any more.
    expect(screen.queryByText('Payment method')).toBeNull();
    fireEvent.press(proceed);

    expect(jest.mocked(router.push)).toHaveBeenCalledWith('/checkout/payment-options');
  });

  it('carries the demo discount into the amount on the button', () => {
    jest.mocked(vendorExtras).mockReturnValue({ ...NO_VENDOR_EXTRAS, top_offer: '10% OFF' });
    useCartStore.getState().addItem(THAMEL_VENDOR, RICE, 1);
    renderWithProviders(<CartScreen />);

    // 1150 - 115 + 50: the same figure as the bill's Total.
    expect(screen.getByTestId('proceed-to-pay')).toHaveTextContent('Proceed to Pay • Rs. 1085');
    expect(within(screen.getByTestId('cart-summary')).getByText('Rs. 1085')).toBeOnTheScreen();
    jest.mocked(vendorExtras).mockReturnValue(NO_VENDOR_EXTRAS);
  });

  it('ignores a payment choice while the cart may not proceed', () => {
    let calls = 0;
    server.use(
      http.post(apiUrl(CHECKOUT_PATH), () => {
        calls += 1;
        return HttpResponse.json(checkoutResponse(), { status: 201 });
      }),
    );
    // Rs. 450 of tea is under Thamel's Rs. 500 minimum.
    useCartStore.getState().addItem(THAMEL_VENDOR, TEA, 1);
    renderWithProviders(<CartScreen />);
    expect(screen.getByTestId('proceed-to-pay')).toBeDisabled();

    payWith('COD');

    expect(calls).toBe(0);
    expect(useCheckoutStore.getState().session).toBeNull();
  });

  it('offers "Add more items", which opens the menu of the shop the cart is from', () => {
    useCartStore.getState().addItem(THAMEL_VENDOR, NOODLES, 1);
    renderWithProviders(<CartScreen />);

    fireEvent.press(screen.getByRole('button', { name: 'Add more items' }));

    // Back down to the Shops tab under the cart, not a second copy of the tabs on top of it.
    expect(jest.mocked(router.dismissTo)).toHaveBeenCalledWith({
      pathname: '/vendor/[id]',
      params: { id: THAMEL_VENDOR.id },
    });
  });

  it('hides "Add more items" while a reservation is waiting for payment', () => {
    useCartStore.getState().addItem(THAMEL_VENDOR, NOODLES, 1);
    useCheckoutStore.getState().startSession(checkoutResponse());
    renderWithProviders(<CartScreen />);

    expect(screen.queryByTestId('cart-add-more')).toBeNull();
    expect(screen.queryByTestId('proceed-to-pay')).toBeNull();
  });
});
