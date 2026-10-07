import { screen, waitFor, within } from '@testing-library/react-native';
import { http, HttpResponse } from 'msw';

import CartScreen from '../../../app/cart';
import { CHECKOUT_PATH } from '../../api/mutations';
import { useCartStore } from '../../store/useCartStore';
import { useOrderReceiptStore } from '../../store/useOrderReceiptStore';
import { checkoutResponse, RICE, THAMEL_VENDOR } from '../../test/api-fixtures';
import { apiUrl, server, setupApiTestEnvironment } from '../../test/msw';
import { payWith } from '../../test/pay-with';
import { renderWithProviders } from '../../test/render';
import { demoTotalNpr } from './demo-pricing';
import type * as MockPromotionsModule from './mock-promotions';
import { vendorExtras } from './mock-promotions';
import type * as PromoModelModule from './promo-model';
import { NO_VENDOR_EXTRAS } from './promo-model';

jest.mock('expo-router', () => ({
  router: { push: jest.fn(), replace: jest.fn() },
  Redirect: () => null,
  Stack: { Screen: () => null },
}));
jest.mock('./mock-promotions', () => {
  const actual = jest.requireActual<typeof MockPromotionsModule>('./mock-promotions');
  const model = jest.requireActual<typeof PromoModelModule>('./promo-model');
  return { ...actual, vendorExtras: jest.fn(() => model.NO_VENDOR_EXTRAS) };
});

setupApiTestEnvironment();

const ORDER = '4a1c0b7e-3f52-4d0a-9c1e-8b7a6d5e4f30';

beforeEach(() => {
  useOrderReceiptStore.getState().resetReceipts();
  jest.mocked(vendorExtras).mockReturnValue(NO_VENDOR_EXTRAS);
});

describe('demo pricing (display only, until /cart/quote exists)', () => {
  it('takes the mock discount off the server total, never below zero', () => {
    expect(demoTotalNpr(1200, 115)).toBe(1085);
    expect(demoTotalNpr(1200.5, 0.25)).toBe(1200.25);
    expect(demoTotalNpr(100, 250)).toBe(0);
  });

  it('shows the server total when there is no discount', () => {
    expect(demoTotalNpr(1200, undefined)).toBe(1200);
    expect(demoTotalNpr(1200, 0)).toBe(1200);
  });
});

describe('checkout keeps a receipt of the order', () => {
  /** The server prices the order in full: 1150 + 50 delivery, no discount. */
  function serveCheckout() {
    const bodies: unknown[] = [];
    server.use(
      http.post(apiUrl(CHECKOUT_PATH), async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json(
          checkoutResponse({
            order: {
              id: ORDER,
              state: 'PLACED',
              payment_method: 'COD',
              subtotal_npr: 1150,
              total_npr: 1200,
            },
            otp: '3057',
          }),
          { status: 201 },
        );
      }),
    );
    return bodies;
  }
  const checkOut = () => {
    payWith('COD');
  };

  it('with the shop, the items, the server’s amounts, the address and the mock discount shown', async () => {
    jest.mocked(vendorExtras).mockReturnValue({
      ...NO_VENDOR_EXTRAS,
      top_offer: '10% OFF',
      locality: 'Thamel',
    });
    const bodies = serveCheckout();
    useCartStore.getState().addItem(THAMEL_VENDOR, RICE, 1);
    renderWithProviders(<CartScreen />);
    expect(within(screen.getByTestId('cart-summary')).getByText('Rs. 1085')).toBeOnTheScreen();

    checkOut();

    await waitFor(() => {
      expect(useOrderReceiptStore.getState().receipts[ORDER]).toBeDefined();
    });
    expect(useOrderReceiptStore.getState().receipts[ORDER]).toMatchObject({
      orderId: ORDER,
      vendor: THAMEL_VENDOR,
      vendorLocation: 'Thamel',
      items: [{ productId: RICE.id, name: 'Basmati Rice 5kg', unitPriceNpr: 1150, quantity: 1 }],
      subtotalNpr: 1150,
      deliveryFeeNpr: 50,
      platformFeeNpr: 0,
      shopDiscountNpr: 115,
      shopOfferLabel: '10% OFF',
      deliveryAddress:
        'Near Kathmandu Guest House, Thamel, Kathmandu Metropolitan City-26, Kathmandu',
    });
    // Nothing about the discount is sent: the request carries ids and quantities only.
    expect(JSON.stringify(bodies)).not.toMatch(/discount|115|1085/);
  });

  it('with the delivery fee the cart showed as free, which the server still charged', async () => {
    jest.mocked(vendorExtras).mockReturnValue({ ...NO_VENDOR_EXTRAS, top_offer: 'Free delivery' });
    const bodies = serveCheckout();
    useCartStore.getState().addItem(THAMEL_VENDOR, RICE, 1);
    renderWithProviders(<CartScreen />);
    expect(within(screen.getByTestId('cart-delivery-fee')).getByText('FREE')).toBeOnTheScreen();

    checkOut();

    await waitFor(() => {
      expect(useOrderReceiptStore.getState().receipts[ORDER]).toBeDefined();
    });
    expect(useOrderReceiptStore.getState().receipts[ORDER]).toMatchObject({
      // The server's own figure, and beside it what the cart waived for display.
      deliveryFeeNpr: 50,
      deliveryDiscountNpr: 50,
      shopDiscountNpr: 0,
      shopOfferLabel: null,
    });
    expect(JSON.stringify(bodies)).not.toMatch(/discount|free|delivery_fee/i);
  });

  it('with no discount for a shop without a mock offer', async () => {
    serveCheckout();
    useCartStore.getState().addItem(THAMEL_VENDOR, RICE, 1);
    renderWithProviders(<CartScreen />);

    checkOut();

    await waitFor(() => {
      expect(useOrderReceiptStore.getState().receipts[ORDER]).toBeDefined();
    });
    expect(useOrderReceiptStore.getState().receipts[ORDER]).toMatchObject({
      shopDiscountNpr: 0,
      shopOfferLabel: null,
      deliveryDiscountNpr: 0,
      vendorLocation: null,
    });
  });
});
