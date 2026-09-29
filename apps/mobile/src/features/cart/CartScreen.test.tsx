import { fireEvent, screen, within } from '@testing-library/react-native';
import { http, HttpResponse } from 'msw';

import CartScreen from '../../../app/(tabs)/cart';
import { CHECKOUT_PATH } from '../../api/mutations';
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

  it('blocks checkout below the vendor minimum order value (SPEC step 5)', () => {
    useCartStore.getState().addItem(THAMEL_VENDOR, TEA, 1);
    renderWithProviders(<CartScreen />);

    expect(
      screen.getByText("Add Rs. 50 more to reach this shop's minimum order."),
    ).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Proceed to Checkout' })).toBeDisabled();
  });

  it('checks out with the chosen method, then shows the reservation and freezes the cart', async () => {
    const received: CapturedRequest[] = [];
    server.use(
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

    expect(await screen.findByTestId('reservation-countdown')).toBeOnTheScreen();
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
