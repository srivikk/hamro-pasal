import { screen, within } from '@testing-library/react-native';

import { createOrderReceiptStore, type OrderReceipt } from '../../store/useOrderReceiptStore';
import { NOODLES, THAMEL_VENDOR } from '../../test/api-fixtures';
import { InMemoryMmkv } from '../../test/in-memory-mmkv';
import { renderWithProviders } from '../../test/render';
import { mmkvStateStorage } from '../../storage/mmkv-state-storage';
import { cartTotals } from '../cart/cart-totals';
import { BillDetails } from '../order/BillDetails';
import { demoTotalNpr, receiptMockSavingsNpr } from './demo-pricing';
import type * as MockPromotionsModule from './mock-promotions';
import { mockFreeDelivery, vendorExtras } from './mock-promotions';
import type * as PromoModelModule from './promo-model';
import { NO_VENDOR_EXTRAS } from './promo-model';

jest.mock('./mock-promotions', () => {
  const actual = jest.requireActual<typeof MockPromotionsModule>('./mock-promotions');
  const model = jest.requireActual<typeof PromoModelModule>('./promo-model');
  return { ...actual, vendorExtras: jest.fn(() => model.NO_VENDOR_EXTRAS) };
});

const offer = (label: string | null): void => {
  jest.mocked(vendorExtras).mockReturnValue({ ...NO_VENDOR_EXTRAS, top_offer: label });
};
/** Two cartons of noodles from Thamel: Rs. 1200, delivery Rs. 50. */
const LINES = [{ unitPriceNpr: NOODLES.unitPriceNpr, quantity: 2 }];

function receipt(overrides: Partial<OrderReceipt> = {}): OrderReceipt {
  return {
    orderId: 'order-1',
    placedAtMs: 1_000,
    vendor: THAMEL_VENDOR,
    vendorLocation: null,
    items: [{ productId: NOODLES.id, name: NOODLES.name, unitPriceNpr: 600, quantity: 2 }],
    subtotalNpr: 1200,
    deliveryFeeNpr: 50,
    platformFeeNpr: 0,
    shopDiscountNpr: 0,
    shopOfferLabel: null,
    deliveryDiscountNpr: 0,
    deliveryAddress: null,
    ...overrides,
  };
}

describe('mock "Free delivery" (display only, until POST /api/cart/quote exists)', () => {
  it.each([
    ['Free delivery', true],
    ['FREE DELIVERY', true],
    ['Dashain: free delivery above Rs. 500', true],
    ['10% OFF', false],
    ['Flat Rs. 200 OFF', false],
    ['Free gift', false],
    [null, false],
  ])('reads %p as waiving the fee: %p', (label, waived) => {
    expect(mockFreeDelivery(label)).toBe(waived);
  });

  it('takes the delivery fee, and only it, off the total shown', () => {
    offer('Free delivery');

    expect(cartTotals(THAMEL_VENDOR, LINES)).toMatchObject({
      shopDiscountNpr: 0,
      deliveryDiscountNpr: 50,
      displayedDeliveryFeeNpr: 0,
      savedNpr: 50,
      displayedTotalNpr: 1200,
    });
    // The estimate of what the server charges is untouched.
    expect(cartTotals(THAMEL_VENDOR, LINES).summary).toMatchObject({
      deliveryFeeNpr: 50,
      totalNpr: 1250,
    });
  });

  it('leaves the fee alone for any other offer, and for none', () => {
    offer('10% OFF');
    expect(cartTotals(THAMEL_VENDOR, LINES)).toMatchObject({
      shopDiscountNpr: 120,
      deliveryDiscountNpr: 0,
      displayedDeliveryFeeNpr: 50,
      savedNpr: 120,
      displayedTotalNpr: 1130,
    });

    offer(null);
    expect(cartTotals(THAMEL_VENDOR, LINES)).toMatchObject({
      deliveryDiscountNpr: 0,
      savedNpr: 0,
      displayedTotalNpr: 1250,
    });
  });

  it('adds the waived fee to what an order screen takes off the server total', () => {
    expect(receiptMockSavingsNpr(undefined)).toBeUndefined();
    expect(receiptMockSavingsNpr(receipt())).toBe(0);
    expect(receiptMockSavingsNpr(receipt({ deliveryDiscountNpr: 50 }))).toBe(50);
    expect(receiptMockSavingsNpr(receipt({ shopDiscountNpr: 120, deliveryDiscountNpr: 50 }))).toBe(
      170,
    );
    expect(demoTotalNpr(1250, receiptMockSavingsNpr(receipt({ deliveryDiscountNpr: 50 })))).toBe(
      1200,
    );
  });
});

describe('order receipt: the waived delivery fee', () => {
  it('is kept with the receipt', () => {
    const store = createOrderReceiptStore(mmkvStateStorage(new InMemoryMmkv()));

    store.getState().saveReceipt(receipt({ deliveryDiscountNpr: 50 }));

    expect(store.getState().receipts['order-1']).toMatchObject({ deliveryDiscountNpr: 50 });
  });

  it('reads a receipt saved before the field existed as "nothing waived"', () => {
    const storage = new InMemoryMmkv();
    const { deliveryDiscountNpr: _dropped, ...old } = receipt();
    storage.set(
      'hamro-pasal.order-receipts',
      JSON.stringify({ state: { receipts: { 'order-1': old } }, version: 1 }),
    );

    const store = createOrderReceiptStore(mmkvStateStorage(storage));

    expect(store.getState().receipts['order-1']).toMatchObject({
      orderId: 'order-1',
      deliveryDiscountNpr: 0,
    });
  });
});

describe('Bill Details: free delivery', () => {
  it('shows the fee as FREE and the total without it', () => {
    renderWithProviders(
      <BillDetails
        receipt={receipt({ deliveryDiscountNpr: 50 })}
        serverTotalNpr={1250}
        paymentMethod="COD"
      />,
    );

    const fee = within(screen.getByTestId('bill-delivery-fee'));
    expect(fee.getByText('FREE')).toBeOnTheScreen();
    expect(fee.queryByText('Rs. 50')).toBeNull();
    expect(within(screen.getByTestId('bill-total')).getByText('Rs. 1200')).toBeOnTheScreen();
    // A waived fee is not a shop discount.
    expect(screen.queryByTestId('bill-shop-discount')).toBeNull();
  });

  it('shows both a shop discount and a free delivery when the order had both', () => {
    renderWithProviders(
      <BillDetails
        receipt={receipt({
          shopDiscountNpr: 120,
          shopOfferLabel: '10% OFF',
          deliveryDiscountNpr: 50,
        })}
        serverTotalNpr={1250}
        paymentMethod="COD"
      />,
    );

    expect(within(screen.getByTestId('bill-delivery-fee')).getByText('FREE')).toBeOnTheScreen();
    expect(within(screen.getByTestId('bill-shop-discount')).getByText('- Rs. 120')).toBeTruthy();
    expect(within(screen.getByTestId('bill-total')).getByText('Rs. 1080')).toBeOnTheScreen();
  });

  it('charges the fee as before when nothing was waived', () => {
    renderWithProviders(
      <BillDetails receipt={receipt()} serverTotalNpr={1250} paymentMethod="COD" />,
    );

    expect(within(screen.getByTestId('bill-delivery-fee')).getByText('Rs. 50')).toBeOnTheScreen();
    expect(within(screen.getByTestId('bill-total')).getByText('Rs. 1250')).toBeOnTheScreen();
  });
});
