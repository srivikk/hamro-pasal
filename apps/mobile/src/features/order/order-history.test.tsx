import { fireEvent, screen, within } from '@testing-library/react-native';
import { router } from 'expo-router';
import { Alert } from 'react-native';
import type { StateStorage } from 'zustand/middleware';

import OrderDetailScreen from '../../../app/order/[id]';
import OrdersScreen from '../../../app/orders';
import { createI18n } from '../../i18n/i18n';
import { useCartStore } from '../../store/useCartStore';
import { useCheckoutStore } from '../../store/useCheckoutStore';
import {
  createOrderReceiptStore,
  MAX_ORDER_RECEIPTS,
  ORDER_RECEIPT_STORE_KEY,
  useOrderReceiptStore,
  type OrderReceipt,
} from '../../store/useOrderReceiptStore';
import { useOrderStore } from '../../store/useOrderStore';
import { useToastStore } from '../../store/useToastStore';
import { checkoutResponse, NOODLES, RICE, THAMEL_VENDOR } from '../../test/api-fixtures';
import { FakeSocket } from '../../test/fake-socket';
import { setupApiTestEnvironment } from '../../test/msw';
import { renderWithProviders } from '../../test/render';
import { itemSummary, ORDER_STATE_TONE, orderCode, reorder } from './order-history';

const mockSocket = new FakeSocket();
jest.mock('socket.io-client', () => ({
  io: (url: string, options: { auth?: unknown }) => mockSocket.created(url, options),
}));
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ id: '0b7e9c1a-2f4d-4c8e-9a6b-1d2e3f4a5b6c' }),
  Stack: { Screen: () => null },
  Redirect: () => null,
  router: { push: jest.fn() },
}));

setupApiTestEnvironment();

const ORDER = '0b7e9c1a-2f4d-4c8e-9a6b-1d2e3f4a5b6c';
const OTHER = '0b7e9c1a-2f4d-4c8e-9a6b-1d2e3f4a5b6d';
const BOUDHA = {
  id: '6f1c2a10-0000-4000-8000-000000000014',
  name: 'Boudha Fresh Mart',
  deliveryFeeNpr: 60,
  minOrderValueNpr: 300,
};

/**
 * Rice x1 and noodles x2 from Thamel: 2350 + 50 delivery, less the shop's own offer (100) and a
 * platform promo (135), as the server priced the order: 2165.
 */
const DISCOUNTED_TOTAL = 2165;
function receipt(overrides: Partial<OrderReceipt> = {}): OrderReceipt {
  return {
    orderId: ORDER,
    placedAtMs: 2_000,
    vendor: THAMEL_VENDOR,
    vendorLocation: 'Thamel',
    items: [
      { productId: RICE.id, name: RICE.name, unitPriceNpr: 1150, quantity: 1 },
      { productId: NOODLES.id, name: NOODLES.name, unitPriceNpr: 600, quantity: 2 },
    ],
    subtotalNpr: 2350,
    deliveryFeeNpr: 50,
    platformFeeNpr: 0,
    vendorOfferDiscountNpr: 100,
    vendorOfferLabel: 'Flat Rs. 100 OFF',
    platformPromoDiscountNpr: 135,
    platformPromoLabel: 'Dashain 6%',
    deliveryAddress:
      'Near Kathmandu Guest House, Thamel, Kathmandu Metropolitan City-26, Kathmandu',
    ...overrides,
  };
}

const NO_DISCOUNT = {
  vendorOfferDiscountNpr: 0,
  vendorOfferLabel: null,
  platformPromoDiscountNpr: 0,
  platformPromoLabel: null,
} as const;

function track(orderId: string, state: 'PLACED' | 'DELIVERED' | 'CANCELED', totalNpr = 2400) {
  useOrderStore
    .getState()
    .trackPlaced({ orderId, paymentMethod: 'COD', totalNpr }, orderId === ORDER ? 2_000 : 1_000);
  if (state !== 'PLACED') useOrderStore.getState().setState(orderId, state);
}

let alert: jest.SpyInstance;

beforeEach(() => {
  jest.clearAllMocks();
  useOrderStore.setState(useOrderStore.getInitialState(), true);
  useOrderReceiptStore.getState().resetReceipts();
  useToastStore.setState({ toast: null });
  alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
});
afterEach(() => {
  alert.mockRestore();
});

/** Presses a button of the last Alert.alert, by its text. */
function pressAlertButton(text: string): void {
  const buttons = ((alert.mock.calls.at(-1) as unknown[] | undefined)?.[2] ?? []) as {
    text?: string;
    onPress?: () => void;
  }[];
  const button = buttons.find((candidate) => candidate.text === text);
  if (button === undefined) throw new Error(`The alert has no "${text}" button`);
  button.onPress?.();
}

describe('order receipts (the phone’s own record of an order)', () => {
  it('keeps one receipt per order, the newest twenty', () => {
    const { saveReceipt } = useOrderReceiptStore.getState();
    for (let index = 0; index < MAX_ORDER_RECEIPTS + 3; index += 1) {
      saveReceipt(receipt({ orderId: `order-${String(index)}`, placedAtMs: index }));
    }
    saveReceipt(receipt({ orderId: 'order-22', placedAtMs: 22, vendorLocation: 'Asan' }));

    const kept = useOrderReceiptStore.getState().receipts;
    expect(Object.keys(kept)).toHaveLength(MAX_ORDER_RECEIPTS);
    expect(kept['order-0']).toBeUndefined();
    expect(kept['order-2']).toBeUndefined();
    expect(kept['order-3']).toBeDefined();
    expect(kept['order-22']?.vendorLocation).toBe('Asan');
  });

  it('refuses a receipt that makes no sense', () => {
    const { saveReceipt } = useOrderReceiptStore.getState();

    expect(() => {
      saveReceipt(receipt({ items: [] }));
    }).toThrow();
    expect(() => {
      saveReceipt(receipt({ vendorOfferDiscountNpr: -1 }));
    }).toThrow();
    expect(useOrderReceiptStore.getState().receipts).toEqual({});
  });

  it('restores what was stored and drops anything that no longer fits', () => {
    const stored = JSON.stringify({
      version: 1,
      state: { receipts: { [ORDER]: receipt(), broken: { orderId: 'broken', items: 'none' } } },
    });
    const storage: StateStorage<void> = {
      getItem: (key) => (key === ORDER_RECEIPT_STORE_KEY ? stored : null),
      setItem: () => undefined,
      removeItem: () => undefined,
    };

    const restored = createOrderReceiptStore(storage).getState().receipts;

    expect(Object.keys(restored)).toEqual([ORDER]);
    expect(restored[ORDER]).toEqual(receipt());
  });
});

describe('order history helpers', () => {
  const { t } = createI18n('en');

  it('summarises the items as the first line and how many more', () => {
    const { items } = receipt();

    expect(itemSummary(items, t)).toBe('1x Basmati Rice 5kg & 1 more');
    expect(itemSummary(items.slice(0, 1), t)).toBe('1x Basmati Rice 5kg');
    expect(
      itemSummary([...items, { productId: 'p3', name: 'Tea', unitPriceNpr: 450, quantity: 3 }], t),
    ).toBe('1x Basmati Rice 5kg & 2 more');
    expect(itemSummary([], t)).toBe('');
  });

  it('writes the summary with Devanagari digits in Nepali', () => {
    expect(itemSummary(receipt().items, createI18n('ne').t)).toBe('१x Basmati Rice 5kg र थप १');
  });

  it('colours delivered green and cancelled or failed red', () => {
    expect(ORDER_STATE_TONE.DELIVERED).toContain('green');
    expect(ORDER_STATE_TONE.CANCELED).toContain('red');
    expect(ORDER_STATE_TONE.FAILED).toContain('red');
    for (const state of ['PLACED', 'PREPARING', 'OUT_FOR_DELIVERY', 'PENDING_PAYMENT'] as const) {
      expect(ORDER_STATE_TONE[state]).not.toMatch(/green|red/);
    }
    expect(orderCode(ORDER)).toBe('4A5B6C');
  });
});

describe('Your Orders: order cards', () => {
  it('shows the shop, its location, the status, the items, the total and Reorder', () => {
    track(ORDER, 'DELIVERED', DISCOUNTED_TOTAL);
    useOrderReceiptStore.getState().saveReceipt(receipt());
    renderWithProviders(<OrdersScreen />);

    const card = within(screen.getByTestId(`order-card-${ORDER}`));
    expect(card.getByText('Thamel Kirana Pasal')).toBeOnTheScreen();
    expect(card.getByText('Thamel')).toBeOnTheScreen();
    expect(card.getByText('Order #4A5B6C')).toBeOnTheScreen();
    expect(card.getByTestId(`order-status-${ORDER}`)).toHaveTextContent('Delivered');
    expect(card.getByTestId(`order-items-${ORDER}`)).toHaveTextContent(
      '1x Basmati Rice 5kg & 1 more',
    );
    // The order's own total, as the server charged it.
    expect(card.getByTestId(`order-total-${ORDER}`)).toHaveTextContent('Rs. 2165');
    expect(card.getByText('Cash on delivery')).toBeOnTheScreen();
    expect(card.getByRole('button', { name: 'Reorder from Thamel Kirana Pasal' })).toBeTruthy();
  });

  it('shows a cancelled order as cancelled, and the server total when nothing was discounted', () => {
    track(ORDER, 'CANCELED');
    useOrderReceiptStore.getState().saveReceipt(receipt({ ...NO_DISCOUNT, vendorLocation: null }));
    renderWithProviders(<OrdersScreen />);

    const card = within(screen.getByTestId(`order-card-${ORDER}`));
    expect(card.getByTestId(`order-status-${ORDER}`)).toHaveTextContent('Cancelled');
    expect(card.getByTestId(`order-total-${ORDER}`)).toHaveTextContent('Rs. 2400');
    expect(card.queryByText('Thamel')).toBeNull();
  });

  it('shows an order without a receipt by its code, with no Reorder', () => {
    track(OTHER, 'PLACED', 650);
    renderWithProviders(<OrdersScreen />);

    const card = within(screen.getByTestId(`order-card-${OTHER}`));
    expect(card.getByText('Order #4A5B6D')).toBeOnTheScreen();
    expect(card.getByTestId(`order-total-${OTHER}`)).toHaveTextContent('Rs. 650');
    expect(card.queryByTestId(`order-items-${OTHER}`)).toBeNull();
    expect(card.queryByRole('button', { name: /Reorder/ })).toBeNull();
  });

  it('opens the order from its card', () => {
    track(ORDER, 'DELIVERED', DISCOUNTED_TOTAL);
    useOrderReceiptStore.getState().saveReceipt(receipt());
    renderWithProviders(<OrdersScreen />);

    fireEvent.press(screen.getByTestId(`order-row-${ORDER}`));

    expect(jest.mocked(router.push)).toHaveBeenCalledWith({
      pathname: '/order/[id]',
      params: { id: ORDER },
    });
  });
});

describe('Reorder', () => {
  beforeEach(() => {
    track(ORDER, 'DELIVERED', DISCOUNTED_TOTAL);
    useOrderReceiptStore.getState().saveReceipt(receipt());
  });
  const pressReorder = () => {
    fireEvent.press(screen.getByTestId(`order-reorder-${ORDER}`));
  };

  it('fills an empty cart with the order’s items and opens the cart', () => {
    renderWithProviders(<OrdersScreen />);

    pressReorder();

    expect(useCartStore.getState().vendor).toEqual(THAMEL_VENDOR);
    expect(useCartStore.getState().lines).toMatchObject([
      { productId: RICE.id, quantity: 1, unitPriceNpr: 1150 },
      { productId: NOODLES.id, quantity: 2, unitPriceNpr: 600 },
    ]);
    expect(jest.mocked(router.push)).toHaveBeenCalledWith('/cart');
    expect(alert).not.toHaveBeenCalled();
  });

  it('adds to a cart that already holds items of the same shop', () => {
    useCartStore.getState().addItem(THAMEL_VENDOR, RICE, 2);
    renderWithProviders(<OrdersScreen />);

    pressReorder();

    expect(useCartStore.getState().lines).toMatchObject([
      { productId: RICE.id, quantity: 3 },
      { productId: NOODLES.id, quantity: 2 },
    ]);
  });

  it('asks before replacing another shop’s cart, and changes nothing until confirmed', () => {
    useCartStore
      .getState()
      .addItem(BOUDHA, { id: 'tomato', name: 'Fresh Tomatoes 1kg', unitPriceNpr: 90 }, 1);
    renderWithProviders(<OrdersScreen />);

    pressReorder();

    expect(alert).toHaveBeenCalledWith(
      'Replace cart items?',
      'Your cart contains items from Boudha Fresh Mart. Do you want to discard them to start a new order with Thamel Kirana Pasal?',
      expect.any(Array),
    );
    expect(useCartStore.getState().vendor?.id).toBe(BOUDHA.id);
    expect(jest.mocked(router.push)).not.toHaveBeenCalled();

    pressAlertButton('Clear Cart');

    expect(useCartStore.getState().vendor?.id).toBe(THAMEL_VENDOR.id);
    expect(useCartStore.getState().lines.map((line) => line.productId)).toEqual([
      RICE.id,
      NOODLES.id,
    ]);
    expect(jest.mocked(router.push)).toHaveBeenCalledWith('/cart');
  });

  it('keeps the other shop’s cart when the customer cancels', () => {
    useCartStore
      .getState()
      .addItem(BOUDHA, { id: 'tomato', name: 'Fresh Tomatoes 1kg', unitPriceNpr: 90 }, 1);
    renderWithProviders(<OrdersScreen />);

    pressReorder();
    pressAlertButton('Cancel');

    expect(useCartStore.getState().lines.map((line) => line.name)).toEqual(['Fresh Tomatoes 1kg']);
    expect(jest.mocked(router.push)).not.toHaveBeenCalled();
  });

  it('does nothing while a checkout is waiting for payment', () => {
    useCheckoutStore.getState().startSession(checkoutResponse());
    renderWithProviders(<OrdersScreen />);

    pressReorder();

    expect(useCartStore.getState().lines).toEqual([]);
    expect(useToastStore.getState().toast).toMatchObject({
      message: 'Finish your current checkout before adding more items.',
    });
    expect(jest.mocked(router.push)).not.toHaveBeenCalled();
  });

  it('reports whether a replacement is needed', () => {
    useCartStore
      .getState()
      .addItem(BOUDHA, { id: 'tomato', name: 'Fresh Tomatoes 1kg', unitPriceNpr: 90 }, 1);

    expect(reorder(receipt())).toBe('needs_replace');
    expect(reorder(receipt(), true)).toBe('added');
  });
});

describe('Order detail: receipt', () => {
  it('shows the shop, the status, the items, the bill and the delivery address', () => {
    track(ORDER, 'DELIVERED', DISCOUNTED_TOTAL);
    useOrderReceiptStore.getState().saveReceipt(receipt());
    renderWithProviders(<OrderDetailScreen />);

    expect(screen.getByTestId('order-vendor')).toHaveTextContent('Thamel Kirana Pasal');
    expect(screen.getByTestId('order-status')).toHaveTextContent('Delivered');
    // The timeline is still there.
    expect(screen.getByTestId('order-tracker')).toBeOnTheScreen();

    const items = within(screen.getByTestId('order-items'));
    expect(items.getByText('1x Basmati Rice 5kg')).toBeOnTheScreen();
    expect(items.getByText('Rs. 1150')).toBeOnTheScreen();
    expect(items.getByText(`2x ${NOODLES.name}`)).toBeOnTheScreen();
    expect(items.getByText('Rs. 1200')).toBeOnTheScreen();

    expect(within(screen.getByTestId('order-address')).getByText(/Thamel, Kathmandu/)).toBeTruthy();
  });

  it('lays the bill out as item total, shop offer, promo, delivery fee, platform fee, total, payment', () => {
    track(ORDER, 'DELIVERED', DISCOUNTED_TOTAL);
    useOrderReceiptStore.getState().saveReceipt(receipt());
    renderWithProviders(<OrderDetailScreen />);

    const bill = within(screen.getByTestId('bill-details'));
    expect(bill.getByText('Bill Details')).toBeOnTheScreen();
    expect(bill.getByTestId('bill-item-total')).toHaveTextContent('Item TotalRs. 2350');
    expect(bill.getByTestId('bill-delivery-fee')).toHaveTextContent('Delivery FeeRs. 50');
    expect(bill.getByTestId('bill-platform-fee')).toHaveTextContent('Platform FeeRs. 0');
    expect(bill.getByTestId('bill-shop-discount')).toHaveTextContent(
      'Shop Offer · Flat Rs. 100 OFF- Rs. 100',
    );
    expect(bill.getByTestId('bill-promo-discount')).toHaveTextContent(
      'Hamro Pasal Promo · Dashain 6%- Rs. 135',
    );
    // 2350 - 100 - 135 + 50 + 0: the server's total, not a sum made here.
    expect(bill.getByTestId('bill-total')).toHaveTextContent('TotalRs. 2165');
    expect(bill.getByTestId('bill-payment-method')).toHaveTextContent(
      'Payment MethodCash on delivery',
    );
  });

  it('has no discount line, and the server’s total, for an order that had none', () => {
    track(ORDER, 'DELIVERED');
    useOrderReceiptStore.getState().saveReceipt(receipt(NO_DISCOUNT));
    renderWithProviders(<OrderDetailScreen />);

    const bill = within(screen.getByTestId('bill-details'));
    expect(bill.queryByTestId('bill-shop-discount')).toBeNull();
    expect(bill.getByTestId('bill-total')).toHaveTextContent('TotalRs. 2400');
  });

  it('shows only the total and the payment method for an order without a receipt', () => {
    track(ORDER, 'DELIVERED');
    renderWithProviders(<OrderDetailScreen />);

    const bill = within(screen.getByTestId('bill-details'));
    expect(bill.getByTestId('bill-total')).toHaveTextContent('TotalRs. 2400');
    expect(bill.getByTestId('bill-payment-method')).toBeOnTheScreen();
    expect(bill.queryByTestId('bill-item-total')).toBeNull();
    expect(screen.queryByTestId('order-vendor')).toBeNull();
    expect(screen.queryByTestId('order-items')).toBeNull();
    expect(screen.queryByTestId('order-address')).toBeNull();
    expect(screen.getByText('Order #4A5B6C')).toBeOnTheScreen();
  });

  it('writes the bill in Nepali with Devanagari digits', () => {
    track(ORDER, 'DELIVERED', DISCOUNTED_TOTAL);
    useOrderReceiptStore.getState().saveReceipt(receipt());
    renderWithProviders(<OrderDetailScreen />, { locale: 'ne' });

    const bill = within(screen.getByTestId('bill-details'));
    expect(bill.getByText('बिल विवरण')).toBeOnTheScreen();
    expect(bill.getByTestId('bill-total')).toHaveTextContent('जम्मारु. २१६५');
    expect(bill.getByTestId('bill-shop-discount')).toHaveTextContent(
      'पसलको अफर · Flat Rs. 100 OFF- रु. १००',
    );
  });
});
