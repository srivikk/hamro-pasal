import type { VendorOrderView } from '@hamro-pasal/shared-types';

import type { MockBoardEntry } from './order-board';

/**
 * TEMPORARY: sample orders on the vendor dashboard, so the board can be tried without a customer
 * placing orders. Development builds only, and off with `EXPO_PUBLIC_MOCK_VENDOR_ORDERS=false` in
 * `apps/mobile/.env`. A sample order never reaches the server: its buttons only move it on the
 * device, and it does not ring the alarm.
 */
export const VENDOR_ORDER_MOCKS_ENABLED =
  __DEV__ && process.env.EXPO_PUBLIC_MOCK_VENDOR_ORDERS !== 'false';

/** A new sample order arrives this often while the shop is online. */
export const MOCK_ORDER_INTERVAL_MS = 30_000;
/** No further sample order arrives while this many wait unanswered (the screen stays open 24/7). */
export const MAX_WAITING_MOCK_ORDERS = 5;

const MOCK_VENDOR_ID = '00000000-0000-4000-8000-00000000aaaa';

const CUSTOMERS = ['Sita', 'Aarav', 'Pooja', 'Bikash', 'Anita', 'Ramesh'] as const;
const TOLES = ['Thamel', 'Lazimpat', 'Baluwatar', 'Naxal', 'Chhetrapati'] as const;
const PAYMENT_METHODS = ['COD', 'ESEWA', 'KHALTI'] as const;

/** The seeded Thamel shop's catalogue (packages/db seed). */
const PRODUCTS = [
  { id: '00000000-0000-4000-8000-000000000001', name: 'Wai Wai Noodles (pack of 30)', price: 600 },
  { id: '00000000-0000-4000-8000-000000000002', name: 'Basmati Rice 5kg', price: 1150 },
  { id: '00000000-0000-4000-8000-000000000003', name: 'Ilam Tea 500g', price: 450 },
  { id: '00000000-0000-4000-8000-000000000004', name: 'Masoor Dal 1kg', price: 220 },
  { id: '00000000-0000-4000-8000-000000000005', name: 'DDC Ghee 500ml', price: 750 },
] as const;

function pick<T>(values: readonly T[], index: number): T {
  const value = values[index % values.length];
  if (value === undefined) throw new Error('pick() needs a non-empty list');
  return value;
}

/**
 * The `sequence`-th sample order, placed at `placedAtMs`. Deterministic: the same sequence always
 * gives the same customer, items and payment, so tests can name them. Every third order is a
 * platform-fleet order; the others are the shop's own delivery.
 */
export function buildMockOrder(
  sequence: number,
  placedAtMs: number,
  state: VendorOrderView['state'] = 'PLACED',
): MockBoardEntry {
  // A spread of hex digits, so the six-character order codes do not all look alike.
  const hex = (Math.imul(sequence + 1, 0x9e3779b1) >>> 0).toString(16).padStart(8, '0');
  const paymentMethod = pick(PAYMENT_METHODS, sequence);
  const first = pick(PRODUCTS, sequence);
  const second = pick(PRODUCTS, sequence + 2);
  const lines = [
    { product: first, quantity: (sequence % 3) + 1 },
    ...(sequence % 2 === 0 ? [{ product: second, quantity: 1 }] : []),
  ];
  const subtotal = lines.reduce((sum, line) => sum + line.product.price * line.quantity, 0);
  const deliveryFee = 50;
  const placedAt = new Date(placedAtMs).toISOString();

  return {
    customerName: pick(CUSTOMERS, sequence),
    order: {
      id: `${hex}-0000-4000-8000-${String(sequence).padStart(4, '0')}${hex}`,
      vendor_id: MOCK_VENDOR_ID,
      state,
      payment_method: paymentMethod,
      payment_status: paymentMethod === 'COD' ? 'PENDING' : 'PAID',
      fulfillment: sequence % 3 === 2 ? 'PLATFORM_FLEET' : 'SELF_DELIVERY',
      subtotal_npr: subtotal,
      vendor_offer_discount_npr: 0,
      platform_promo_discount_npr: 0,
      delivery_fee_npr: deliveryFee,
      total_npr: subtotal + deliveryFee,
      created_at: placedAt,
      placed_at: placedAt,
      delivery_address: {
        province_id: 3,
        district_string: 'Kathmandu',
        municipality_palika_string: 'Kathmandu Metropolitan City',
        ward_number: 26 + (sequence % 4),
        tole_locality: pick(TOLES, sequence),
        landmark: 'Sample order',
        exact_lat: 27.7154,
        exact_lng: 85.3123,
      },
      items: lines.map((line) => ({
        product_id: line.product.id,
        product_name: line.product.name,
        unit_price_npr: line.product.price,
        quantity: line.quantity,
      })),
    },
  };
}

const MINUTE_MS = 60_000;

/**
 * The board a development build opens on: one sample order in every column. Each is placed half
 * a minute past a whole number of minutes ago, so its age reads the same whichever of the seed
 * and the screen's clock ran first.
 */
export function seedMockOrders(nowMs: number): MockBoardEntry[] {
  const ago = (minutes: number): number => nowMs - (minutes + 0.5) * MINUTE_MS;
  return [
    buildMockOrder(0, ago(1), 'PLACED'),
    buildMockOrder(1, ago(9), 'PREPARING'),
    buildMockOrder(3, ago(22), 'OUT_FOR_DELIVERY'), // own delivery: Ready
    { ...buildMockOrder(2, ago(40), 'OUT_FOR_DELIVERY'), riderPickedUp: true }, // fleet: collected
  ];
}

/** The sequence number of the first order that arrives after the seed. */
export const FIRST_INCOMING_MOCK_SEQUENCE = 4;
