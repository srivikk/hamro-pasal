import { act, fireEvent, screen, waitFor, within } from '@testing-library/react-native';
import { router } from 'expo-router';
import { http, HttpResponse } from 'msw';
import { Alert } from 'react-native';

import CartScreen from '../../../app/cart';
import { CART_QUOTE_PATH } from '../../api/cart-quote';
import { CHECKOUT_PATH } from '../../api/mutations';
import { KHALTI_INITIATE_PATH } from '../../api/payments';
import { useAddressStore } from '../../store/useAddressStore';
import { useProfileStore } from '../../store/useProfileStore';
import { useAuthStore } from '../../store/useAuthStore';
import { useCartStore } from '../../store/useCartStore';
import { useCheckoutStore } from '../../store/useCheckoutStore';
import {
  cartQuote,
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
import { usePaymentChoiceStore } from '../checkout/payment-choice';
import type * as MockPromotionsModule from '../promo/mock-promotions';
import type * as PromoModelModule from '../promo/promo-model';

jest.mock('expo-router', () => ({
  router: { push: jest.fn(), replace: jest.fn(), dismissTo: jest.fn() },
  Stack: { Screen: () => null },
}));
// The receipt's shop locality is still a mock extra: none here.
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

  it('summarises subtotal, delivery fee, platform fee and total', async () => {
    useCartStore.getState().addItem(THAMEL_VENDOR, NOODLES, 2);
    renderWithProviders(<CartScreen />);

    expect(summaryRow('Subtotal · 2 items')).toBeOnTheScreen();
    expect(summaryRow('Rs. 1200')).toBeOnTheScreen();
    expect(summaryRow('Delivery fee')).toBeOnTheScreen();
    expect(summaryRow('Rs. 50')).toBeOnTheScreen();
    expect(summaryRow('Platform fee')).toBeOnTheScreen();
    expect(summaryRow('Rs. 0')).toBeOnTheScreen();
    // An estimate until the server has priced the cart.
    expect(summaryRow('Estimated total')).toBeOnTheScreen();
    await waitFor(() => {
      expect(summaryRow('Total')).toBeOnTheScreen();
    });
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
    // With an address the server can price the cart; then the payment step opens.
    await waitFor(() => {
      expect(screen.getByTestId('proceed-to-pay')).toBeEnabled();
    });
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

    expect(screen.getByTestId('proceed-to-pay')).toBeOnTheScreen();
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

  it('keeps the line highlighted while it is stepped down, until it fits', async () => {
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
    await waitFor(() => {
      expect(screen.getByTestId('proceed-to-pay')).toBeEnabled();
    });
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
    await waitFor(() => {
      expect(screen.getByTestId('proceed-to-pay')).toBeEnabled();
    });
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

describe('Cart screen: the server’s quote (POST /api/cart/quote)', () => {
  const OFFER_ID = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c51';
  const CAMPAIGN_ID = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c52';
  /** S 1000, shop offer 100, promo 10% of the remaining 900, delivery 50: SPEC verification 5. */
  const stacked = () =>
    cartQuote({
      subtotal_npr: 1000,
      vendor_offer: { id: OFFER_ID, label: 'Flat Rs. 100 OFF', discount_npr: 100 },
      platform_promo: { id: CAMPAIGN_ID, label: 'Dashain 10%', discount_npr: 90 },
      delivery_fee_npr: 50,
      total_npr: 860,
    });
  const quoteWith = (body: () => object, status = 200) => {
    const received: CapturedRequest[] = [];
    server.use(
      http.post(apiUrl(CART_QUOTE_PATH), async ({ request }) => {
        received.push(await capture(request));
        return HttpResponse.json(body(), { status });
      }),
    );
    return received;
  };
  const TEN = { id: '7a2b3c40-0011-4000-8000-000000000009', name: 'Masoor Dal', unitPriceNpr: 500 };

  it('asks for the cart’s price with ids, quantities and the address, and no amounts', async () => {
    const received = quoteWith(stacked);
    useCartStore.getState().addItem(THAMEL_VENDOR, TEN, 2);
    renderWithProviders(<CartScreen />);
    await screen.findByTestId('cart-shop-discount');

    expect(received[0]?.headers.get('authorization')).toMatch(/^Bearer /);
    expect(received[0]?.body).toEqual({
      vendor_id: THAMEL_VENDOR.id,
      items: [{ product_id: TEN.id, quantity: 2 }],
      delivery_address: THAMEL_ADDRESS,
    });
  });

  it('shows the shop’s offer and the platform promo as separate green lines, in the order applied', async () => {
    quoteWith(stacked);
    useCartStore.getState().addItem(THAMEL_VENDOR, TEN, 2);
    renderWithProviders(<CartScreen />);

    const offer = await screen.findByTestId('cart-shop-discount');
    expect(offer).toHaveTextContent('Shop Offer · Flat Rs. 100 OFF- Rs. 100');
    expect(screen.getByTestId('cart-promo-discount')).toHaveTextContent(
      'Hamro Pasal Promo · Dashain 10%- Rs. 90',
    );
    // The delivery fee is the server's and is never discounted.
    expect(screen.getByTestId('cart-delivery-fee')).toHaveTextContent('Delivery feeRs. 50');
    expect(screen.getByTestId('cart-total')).toHaveTextContent('TotalRs. 860');
    expect(screen.getByTestId('cart-saved')).toHaveTextContent('You save Rs. 190 on this order');
    expect(screen.getByTestId('proceed-to-pay')).toHaveTextContent('Proceed to Pay • Rs. 860');

    // Subtotal, shop offer, promo, delivery fee: top to bottom.
    const rows = within(screen.getByTestId('cart-summary'))
      .getAllByText(/Subtotal|Shop Offer|Hamro Pasal Promo|Delivery fee/)
      .map((row) => String(row.props.children));
    expect(rows.map((row) => row.split(' · ')[0])).toEqual([
      'Subtotal',
      'Shop Offer',
      'Hamro Pasal Promo',
      'Delivery fee',
    ]);
  });

  it('shows no discount line the server did not send, and the server’s delivery charge', async () => {
    // 2.4 km at Rs. 20 per started kilometre on top of the base 50: only the server knows.
    quoteWith(() => cartQuote({ subtotal_npr: 1000, delivery_fee_npr: 110, total_npr: 1110 }));
    useCartStore.getState().addItem(THAMEL_VENDOR, TEN, 2);
    renderWithProviders(<CartScreen />);

    await waitFor(() => {
      expect(screen.getByTestId('cart-total')).toHaveTextContent('TotalRs. 1110');
    });
    expect(screen.getByTestId('cart-delivery-fee')).toHaveTextContent('Delivery feeRs. 110');
    expect(screen.queryByTestId('cart-shop-discount')).toBeNull();
    expect(screen.queryByTestId('cart-promo-discount')).toBeNull();
    expect(screen.queryByTestId('cart-saved')).toBeNull();
  });

  it('says how much more is needed for free delivery, then that it is free (step 7.2)', async () => {
    let remaining = 299;
    quoteWith(() =>
      cartQuote({ free_delivery_threshold_npr: 1000, free_delivery_remaining_npr: remaining }),
    );
    useCartStore.getState().addItem(THAMEL_VENDOR, TEN, 2);
    const view = renderWithProviders(<CartScreen />);

    await waitFor(() => {
      expect(screen.getByTestId('cart-free-delivery')).toHaveTextContent(
        'Add Rs. 299 more for free delivery',
      );
    });

    view.unmount();
    remaining = 0;
    renderWithProviders(<CartScreen />);
    await waitFor(() => {
      expect(screen.getByTestId('cart-free-delivery')).toHaveTextContent(
        'You get free delivery on this order',
      );
    });
  });

  it('shows no free-delivery line for a shop without the offer', async () => {
    quoteWith(() => cartQuote());
    useCartStore.getState().addItem(THAMEL_VENDOR, TEN, 2);
    renderWithProviders(<CartScreen />);

    await waitFor(() => {
      expect(screen.getByTestId('cart-total')).toHaveTextContent('TotalRs. 2400');
    });
    expect(screen.queryByTestId('cart-free-delivery')).toBeNull();
  });

  it('prices the cart again when a quantity changes, and never shows the old quote for the new cart', async () => {
    const received = quoteWith(() => {
      const quantity = useCartStore.getState().lines[0]?.quantity ?? 0;
      const subtotal = 500 * quantity;
      return cartQuote({
        subtotal_npr: subtotal,
        vendor_offer: { id: OFFER_ID, label: '10% OFF', discount_npr: subtotal / 10 },
        total_npr: subtotal - subtotal / 10 + 50,
      });
    });
    useCartStore.getState().addItem(THAMEL_VENDOR, TEN, 2);
    renderWithProviders(<CartScreen />);
    await waitFor(() => {
      expect(screen.getByTestId('cart-total')).toHaveTextContent('TotalRs. 950');
    });

    fireEvent.press(screen.getByRole('button', { name: `Add one ${TEN.name}` }));

    // Until the new quote answers, the bill is an estimate without the old discount.
    expect(screen.getByTestId('cart-total')).toHaveTextContent('Estimated totalRs. 1550');
    expect(screen.queryByTestId('cart-shop-discount')).toBeNull();
    expect(screen.getByTestId('proceed-to-pay')).toBeDisabled();
    await waitFor(() => {
      expect(screen.getByTestId('cart-total')).toHaveTextContent('TotalRs. 1400');
    });
    expect(screen.getByTestId('cart-shop-discount')).toHaveTextContent(
      'Shop Offer · 10% OFF- Rs. 150',
    );
    expect(received).toHaveLength(2);
  });

  it('shows a guest an estimate and asks the server nothing', () => {
    const received = quoteWith(stacked);
    useAuthStore.getState().clearSession();
    useCartStore.getState().addItem(THAMEL_VENDOR, TEN, 2);
    renderWithProviders(<CartScreen />);

    expect(screen.getByTestId('cart-total')).toHaveTextContent('Estimated totalRs. 1050');
    expect(received).toHaveLength(0);
  });

  it('asks for no quote below the shop’s minimum order, which is measured before any discount', () => {
    const received = quoteWith(stacked);
    // One unit of 450 against a minimum of 500.
    useCartStore.getState().addItem(THAMEL_VENDOR, TEA, 1);
    renderWithProviders(<CartScreen />);

    expect(screen.getByTestId('below-minimum')).toBeOnTheScreen();
    expect(screen.getByTestId('proceed-to-pay')).toBeDisabled();
    expect(received).toHaveLength(0);
  });

  it('says delivery is unavailable and blocks the payment step (Emergency Stop)', async () => {
    quoteWith(() =>
      cartQuote({
        subtotal_npr: 1000,
        total_npr: 1050,
        delivery_available: false,
        payment_options: [
          { method: 'ESEWA', available: false, reason: 'DELIVERY_UNAVAILABLE' },
          { method: 'KHALTI', available: false, reason: 'DELIVERY_UNAVAILABLE' },
          { method: 'COD', available: false, reason: 'DELIVERY_UNAVAILABLE' },
        ],
      }),
    );
    useCartStore.getState().addItem(THAMEL_VENDOR, TEN, 2);
    renderWithProviders(<CartScreen />);

    expect(await screen.findByTestId('cart-delivery-unavailable')).toHaveTextContent(
      'Delivery is unavailable right now. You can order when it is back.',
    );
    expect(screen.getByTestId('proceed-to-pay')).toBeDisabled();
  });

  it('explains a refused quote, keeps the estimate, and prices again on "Try again"', async () => {
    let refuse = true;
    quoteWith(() => (refuse ? errorBody('VENDOR_UNAVAILABLE') : stacked()));
    server.use(
      http.post(apiUrl(CART_QUOTE_PATH), () =>
        refuse
          ? HttpResponse.json(errorBody('VENDOR_UNAVAILABLE'), { status: 422 })
          : HttpResponse.json(stacked()),
      ),
    );
    useCartStore.getState().addItem(THAMEL_VENDOR, TEN, 2);
    renderWithProviders(<CartScreen />);

    expect(await screen.findByTestId('checkout-error')).toHaveTextContent(
      'This shop isn’t taking orders right now.'.replace('’', "'"),
    );
    expect(screen.getByTestId('cart-total')).toHaveTextContent('Estimated totalRs. 1050');
    expect(screen.getByTestId('proceed-to-pay')).toBeDisabled();

    refuse = false;
    fireEvent.press(screen.getByTestId('quote-retry'));
    await waitFor(() => {
      expect(screen.getByTestId('cart-total')).toHaveTextContent('TotalRs. 860');
    });
    expect(screen.queryByTestId('checkout-error')).toBeNull();
  });

  it('highlights the lines a quote says are short of stock', async () => {
    server.use(
      http.post(apiUrl(CART_QUOTE_PATH), () =>
        HttpResponse.json(
          errorBody('INSUFFICIENT_STOCK', {
            shortfalls: [{ productId: TEN.id, requested: 4, available: 1 }],
          }),
          { status: 409 },
        ),
      ),
    );
    useCartStore.getState().addItem(THAMEL_VENDOR, TEN, 4);
    renderWithProviders(<CartScreen />);

    expect(await screen.findByTestId(`cart-line-stock-${TEN.id}`)).toBeOnTheScreen();
    expect(useCartStore.getState().lines[0]?.availableStock).toBe(1);
  });

  it('writes the lines in Nepali with Devanagari digits', async () => {
    quoteWith(stacked);
    useCartStore.getState().addItem(THAMEL_VENDOR, TEN, 2);
    renderWithProviders(<CartScreen />, { locale: 'ne' });

    expect(await screen.findByTestId('cart-shop-discount')).toHaveTextContent(
      'पसलको अफर · Flat Rs. 100 OFF- रु. १००',
    );
    expect(screen.getByTestId('cart-promo-discount')).toHaveTextContent(
      'हाम्रो पसल प्रोमो · Dashain 10%- रु. ९०',
    );
  });
});

describe('Cart screen: a checkout the server refuses with a dialog', () => {
  const TEN = { id: '7a2b3c40-0011-4000-8000-000000000009', name: 'Masoor Dal', unitPriceNpr: 500 };
  let alert: jest.SpiedFunction<typeof Alert.alert>;
  const lastAlert = () => {
    const call = alert.mock.calls.at(-1);
    if (call === undefined) throw new Error('No alert was shown');
    return { title: call[0], message: call[1] ?? '', buttons: call[2] ?? [] };
  };
  const pressAlert = (label: string): void => {
    const button = lastAlert().buttons.find((each) => each.text === label);
    if (button === undefined) throw new Error(`No alert button "${label}"`);
    act(() => {
      button.onPress?.();
    });
  };

  beforeEach(() => {
    jest.mocked(router.push).mockClear();
    alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    useCartStore.getState().addItem(THAMEL_VENDOR, TEN, 2);
  });
  afterEach(() => {
    alert.mockRestore();
  });

  /** The first checkout is refused with `refusal`; the next one creates the order. */
  function refuseOnce(code: string, details: unknown, status: number) {
    const received: CapturedRequest[] = [];
    server.use(
      http.post(apiUrl(CHECKOUT_PATH), async ({ request }) => {
        received.push(await capture(request));
        return received.length === 1
          ? HttpResponse.json(errorBody(code, details), { status })
          : HttpResponse.json(
              checkoutResponse({ order: { state: 'PLACED', payment_method: 'COD' } }),
              { status: 201 },
            );
      }),
    );
    return received;
  }
  const ready = async () => {
    renderWithProviders(<CartScreen />);
    await waitFor(() => {
      expect(screen.getByTestId('proceed-to-pay')).toBeEnabled();
    });
  };
  const confirmPayment = (method: 'COD' | 'ESEWA', expectedTotalNpr: number): void => {
    act(() => {
      usePaymentChoiceStore.getState().choose(method, expectedTotalNpr);
    });
  };

  it('sends the total the customer agreed to with the order', async () => {
    const received = refuseOnce('QUOTE_CHANGED', undefined, 409);
    await ready();
    confirmPayment('COD', 1050);

    await waitFor(() => {
      expect(received).toHaveLength(1);
    });
    expect(received[0]?.body).toMatchObject({ payment_method: 'COD', expected_total_npr: 1050 });
  });

  it('409 QUOTE_CHANGED: shows both totals, and places the order at the new one only when accepted', async () => {
    const quote = {
      subtotal_npr: 1000,
      vendor_offer: null,
      platform_promo: null,
      delivery_fee_npr: 50,
      total_npr: 1050,
    };
    const received = refuseOnce('QUOTE_CHANGED', { quote }, 409);
    await ready();
    confirmPayment('COD', 950);
    await waitFor(() => {
      expect(alert).toHaveBeenCalled();
    });

    expect(lastAlert().title).toBe('The price has changed');
    expect(lastAlert().message).toBe(
      'An offer on this cart has ended. The total is now Rs. 1050 (it was Rs. 950). Nothing has been charged.',
    );
    expect(lastAlert().buttons.map((button) => button.text)).toEqual([
      'Review cart',
      'Continue with Rs. 1050',
    ]);
    // Nothing was ordered, and no line of error text competes with the dialog.
    expect(received).toHaveLength(1);
    expect(screen.queryByTestId('checkout-error')).toBeNull();
    expect(useCheckoutStore.getState().session).toBeNull();

    pressAlert('Continue with Rs. 1050');
    await waitFor(() => {
      expect(received).toHaveLength(2);
    });
    expect(received[1]?.body).toMatchObject({ payment_method: 'COD', expected_total_npr: 1050 });
    await waitFor(() => {
      expect(useCheckoutStore.getState().session?.orderState).toBe('PLACED');
    });
  });

  it('409 QUOTE_CHANGED: "Review cart" orders nothing and the bill is priced again', async () => {
    let quotes = 0;
    server.use(
      http.post(apiUrl(CART_QUOTE_PATH), () => {
        quotes += 1;
        return HttpResponse.json(cartQuote({ subtotal_npr: 1000, total_npr: 1050 }));
      }),
    );
    const received = refuseOnce(
      'QUOTE_CHANGED',
      {
        quote: {
          subtotal_npr: 1000,
          vendor_offer: null,
          platform_promo: null,
          delivery_fee_npr: 50,
          total_npr: 1050,
        },
      },
      409,
    );
    await ready();
    const before = quotes;
    confirmPayment('COD', 950);
    await waitFor(() => {
      expect(alert).toHaveBeenCalled();
    });
    pressAlert('Review cart');

    await waitFor(() => {
      expect(quotes).toBeGreaterThan(before);
    });
    expect(received).toHaveLength(1);
  });

  it('409 QUOTE_CHANGED without the new quote: tells the customer to review the cart', async () => {
    refuseOnce('QUOTE_CHANGED', undefined, 409);
    await ready();
    confirmPayment('COD', 950);
    await waitFor(() => {
      expect(alert).toHaveBeenCalled();
    });

    expect(lastAlert().message).toContain('has just ended');
    expect(lastAlert().buttons.map((button) => button.text)).toEqual(['Review cart']);
  });

  it('422 PAYMENT_METHOD_UNAVAILABLE: names what the shop accepts and offers the payment step again', async () => {
    refuseOnce(
      'PAYMENT_METHOD_UNAVAILABLE',
      { accepted: ['COD'], reason: 'SETTLEMENT_MODEL', settlement_model: 'COD_CREDIT' },
      422,
    );
    await ready();
    confirmPayment('ESEWA', 1050);
    await waitFor(() => {
      expect(alert).toHaveBeenCalled();
    });

    expect(lastAlert().title).toBe('Payment method not available');
    expect(lastAlert().message).toBe(
      "This shop can't take eSewa for this order. It accepts: Cash on delivery. Nothing has been charged.",
    );
    expect(screen.queryByTestId('checkout-error')).toBeNull();

    pressAlert('Choose another method');
    expect(jest.mocked(router.push)).toHaveBeenCalledWith('/checkout/payment-options');
  });

  it('422 PAYMENT_METHOD_UNAVAILABLE with nothing accepted: only "OK"', async () => {
    refuseOnce('PAYMENT_METHOD_UNAVAILABLE', { accepted: [], reason: 'NOT_ACCEPTED_BY_SHOP' }, 422);
    await ready();
    confirmPayment('COD', 1050);
    await waitFor(() => {
      expect(alert).toHaveBeenCalled();
    });

    expect(lastAlert().buttons.map((button) => button.text)).toEqual(['OK']);
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

  it('shows one button with the amount to pay, which opens Payment Options', async () => {
    useCartStore.getState().addItem(THAMEL_VENDOR, NOODLES, 2);
    renderWithProviders(<CartScreen />);

    const proceed = screen.getByTestId('proceed-to-pay');
    // Nothing to agree to until the server has priced the cart.
    expect(proceed).toHaveTextContent('Checking the price…');
    expect(proceed).toBeDisabled();
    await waitFor(() => {
      expect(proceed).toHaveTextContent('Proceed to Pay • Rs. 1250');
    });
    // No payment method is chosen in the cart any more.
    expect(screen.queryByText('Payment method')).toBeNull();
    fireEvent.press(proceed);

    expect(jest.mocked(router.push)).toHaveBeenCalledWith('/checkout/payment-options');
  });

  it('puts the server’s discounted total on the button, the same figure as the bill', async () => {
    server.use(
      http.post(apiUrl(CART_QUOTE_PATH), () =>
        HttpResponse.json(
          cartQuote({
            subtotal_npr: 1150,
            vendor_offer: {
              id: '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c51',
              label: '10% OFF',
              discount_npr: 115,
            },
            total_npr: 1085,
          }),
        ),
      ),
    );
    useCartStore.getState().addItem(THAMEL_VENDOR, RICE, 1);
    renderWithProviders(<CartScreen />);

    // 1150 - 115 + 50.
    await waitFor(() => {
      expect(screen.getByTestId('proceed-to-pay')).toHaveTextContent('Proceed to Pay • Rs. 1085');
    });
    expect(screen.getByTestId('cart-total')).toHaveTextContent('TotalRs. 1085');
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
