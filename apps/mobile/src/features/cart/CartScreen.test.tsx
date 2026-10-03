import { act, fireEvent, screen, within } from '@testing-library/react-native';
import { router } from 'expo-router';
import { http, HttpResponse } from 'msw';

import CartScreen from '../../../app/(tabs)/cart';
import { CHECKOUT_PATH } from '../../api/mutations';
import { KHALTI_INITIATE_PATH } from '../../api/payments';
import { useAddressStore } from '../../store/useAddressStore';
import { useAuthStore } from '../../store/useAuthStore';
import { useCartStore } from '../../store/useCartStore';
import { useCheckoutStore } from '../../store/useCheckoutStore';
import { checkoutResponse, errorBody, NOODLES, RICE, THAMEL_VENDOR } from '../../test/api-fixtures';
import {
  apiUrl,
  capture,
  server,
  setupApiTestEnvironment,
  type CapturedRequest,
} from '../../test/msw';
import { renderWithProviders } from '../../test/render';
import { useTerritorySimulator } from '../territory/territory-simulator';

jest.mock('expo-router', () => ({ router: { push: jest.fn(), replace: jest.fn() } }));

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
    expect(screen.getByRole('button', { name: 'Proceed to Checkout' })).toBeDisabled();

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
      'Thamel, Kathmandu Metropolitan City-26, Kathmandu',
    );
    expect(screen.queryByText('Add a delivery address to continue.')).toBeNull();
    expect(screen.getByRole('button', { name: 'Proceed to Checkout' })).toBeEnabled();
    expect(useAddressStore.getState().address?.ward_number).toBe(26);
  });

  it('blocks checkout below the vendor minimum order value (SPEC step 5)', () => {
    useCartStore.getState().addItem(THAMEL_VENDOR, TEA, 1);
    renderWithProviders(<CartScreen />);

    expect(
      screen.getByText("Add Rs. 50 more to reach this shop's minimum order."),
    ).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Proceed to Checkout' })).toBeDisabled();
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

    fireEvent.press(screen.getByTestId('payment-method-KHALTI'));
    fireEvent.press(screen.getByRole('button', { name: 'Proceed to Checkout' }));

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
    expect(screen.queryByRole('button', { name: 'Proceed to Checkout' })).toBeNull();
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

    fireEvent.press(screen.getByTestId('payment-method-COD'));
    fireEvent.press(screen.getByRole('button', { name: 'Proceed to Checkout' }));

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

    fireEvent.press(screen.getByTestId('payment-method-COD'));
    fireEvent.press(screen.getByRole('button', { name: 'Proceed to Checkout' }));

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

  it('replaces "Proceed to Checkout" with "Sign in to Checkout", which opens the login', () => {
    useAuthStore.getState().clearSession();
    renderWithProviders(<CartScreen />);

    expect(screen.queryByRole('button', { name: 'Proceed to Checkout' })).toBeNull();
    fireEvent.press(screen.getByRole('button', { name: 'Sign in to Checkout' }));

    expect(router.push).toHaveBeenCalledWith('/login');
  });

  it('counts a stored refresh token as signed in (the access token is renewed on demand)', () => {
    useAuthStore.getState().setSession({ accessToken: 'a.b.c', refreshToken: 'r.e.f' });
    useAuthStore.setState({ accessToken: null });
    renderWithProviders(<CartScreen />);

    expect(screen.getByRole('button', { name: 'Proceed to Checkout' })).toBeOnTheScreen();
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
    fireEvent.press(screen.getByTestId('payment-method-COD'));
    fireEvent.press(screen.getByRole('button', { name: 'Proceed to Checkout' }));
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
    expect(screen.getByRole('button', { name: 'Proceed to Checkout' })).toBeDisabled();
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

    fireEvent.press(screen.getByRole('button', { name: 'Proceed to Checkout' }));
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
    expect(screen.getByRole('button', { name: 'Proceed to Checkout' })).toBeDisabled();

    fireEvent.press(screen.getByRole('button', { name: `Remove one ${RICE.name}` }));
    expect(screen.queryByTestId(`cart-line-stock-${RICE.id}`)).toBeNull();
    expect(screen.queryByTestId('stock-required')).toBeNull();
    expect(screen.getByRole('button', { name: 'Proceed to Checkout' })).toBeEnabled();
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
    expect(screen.getByRole('button', { name: 'Proceed to Checkout' })).toBeEnabled();
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
    expect(screen.getByRole('button', { name: 'Proceed to Checkout' })).toBeEnabled();
  });

  it('prompts in Nepali with Devanagari numerals', () => {
    useCartStore.getState().addItem(THAMEL_VENDOR, RICE, 4);
    useCartStore.getState().syncStock([{ productId: RICE.id, available: 2 }]);
    renderWithProviders(<CartScreen />, { locale: 'ne' });

    expect(screen.getByText('स्टकमा २ वटा मात्र बाँकी छन्। परिमाण घटाउनुहोस्।')).toBeOnTheScreen();
    expect(screen.getByText('२ वटा राख्नुहोस्')).toBeOnTheScreen();
  });
});
