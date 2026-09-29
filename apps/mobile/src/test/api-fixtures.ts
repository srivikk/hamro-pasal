import {
  cancelOrderResponseSchema,
  checkoutResponseSchema,
  feedResponseSchema,
  lockStatusResponseSchema,
  nepalAddressInputSchema,
  orderDetailResponseSchema,
  vendorMenuSchema,
  type CancelOrderResponseBody,
  type CheckoutResponseBody,
  type FeedResponse,
  type FeedVendor,
  type LockStatusResponseBody,
  type LockView,
  type NepalAddress,
  type OrderSnapshotView,
  type OrderView,
  type VendorMenu,
} from '@hamro-pasal/shared-types';

import type { CartProduct, CartVendor } from '../store/useCartStore';

/*
 * Server responses built through the shared-types response schemas, so a fixture can never drift
 * from the contract the real API is tested against (STATE_HANDOFF §8). Catalogue fixtures mirror
 * the dev seed (Kathmandu valley); the ids are fixed uuids for the tests only.
 */

export const ORDER_ID = '0b7e9c1a-2f4d-4c8e-9a6b-1d2e3f4a5b6c';
export const RESERVATION_ID = '5c6d7e8f-9a0b-4c1d-8e2f-3a4b5c6d7e8f';

/** Thamel Kirana Pasal and two of its products (uuid IDs, as the checkout API requires). */
export const THAMEL_VENDOR: CartVendor = {
  id: '6f1c2a10-0000-4000-8000-000000000011',
  name: 'Thamel Kirana Pasal',
  deliveryFeeNpr: 50,
  minOrderValueNpr: 500,
};

export const NOODLES: CartProduct = {
  id: '7a2b3c40-0011-4000-8000-000000000001',
  name: 'Wai Wai Noodles (carton of 30)',
  unitPriceNpr: 600,
};
export const RICE: CartProduct = {
  id: '7a2b3c40-0011-4000-8000-000000000002',
  name: 'Basmati Rice 5kg',
  unitPriceNpr: 1150,
};

export function orderView(overrides: Partial<OrderView> = {}): OrderView {
  return {
    id: ORDER_ID,
    vendor_id: THAMEL_VENDOR.id,
    state: 'PENDING_PAYMENT',
    payment_method: 'ESEWA',
    payment_status: 'PENDING',
    fulfillment: 'SELF_DELIVERY',
    subtotal_npr: 2350,
    delivery_fee_npr: 50,
    total_npr: 2400,
    created_at: '2026-09-29T10:00:00.000Z',
    ...overrides,
  };
}

export function checkoutResponse(
  overrides: { order?: Partial<OrderView>; expiresAt?: string | null; otp?: string | null } = {},
): CheckoutResponseBody {
  return checkoutResponseSchema.parse({
    order: orderView(overrides.order),
    reservation: {
      id: RESERVATION_ID,
      expires_at:
        overrides.expiresAt === undefined ? '2026-09-29T10:10:00.000Z' : overrides.expiresAt,
    },
    delivery_otp: overrides.otp === undefined ? '4821' : overrides.otp,
    replayed: false,
  });
}

export function lockStatusResponse(
  lock: LockView,
  order: Partial<OrderView> = {},
): LockStatusResponseBody {
  return lockStatusResponseSchema.parse({ order: orderView(order), lock });
}

export function errorBody(code: string, details?: unknown) {
  return {
    error: { code, message: `${code} (test)`, ...(details === undefined ? {} : { details }) },
  };
}

/** The seeded customer's delivery address (Thamel, Kathmandu MC ward 26), schema-validated. */
export const THAMEL_ADDRESS: NepalAddress = nepalAddressInputSchema.parse({
  province_id: 3,
  district_string: 'Kathmandu',
  municipality_palika_string: 'Kathmandu Metropolitan City',
  ward_number: 26,
  tole_locality: 'Thamel',
  landmark: 'Near Kathmandu Guest House',
  exact_lat: 27.7154,
  exact_lng: 85.3123,
});

/* ---------- Catalogue (GET /api/vendors, GET /api/vendors/:id/products) ---------- */

export const PATAN_VENDOR_ID = '6f1c2a10-0000-4000-8000-000000000012';
export const NEW_ROAD_VENDOR_ID = '6f1c2a10-0000-4000-8000-000000000015';

export function feedVendor(overrides: Partial<FeedVendor> = {}): FeedVendor {
  return {
    id: THAMEL_VENDOR.id,
    business_name: THAMEL_VENDOR.name,
    delivery_scope: 'RADIUS_BOUND',
    radius_km: 5,
    municipality_palika_string: 'Kathmandu Metropolitan City',
    min_order_value: 500,
    base_delivery_fee_npr: 50,
    fulfillment_mode: 'SELF_DELIVERY',
    location: { x: 85.3123, y: 27.7154 },
    ...overrides,
  };
}

export const PATAN_VENDOR = feedVendor({
  id: PATAN_VENDOR_ID,
  business_name: 'Patan Organic Store',
  delivery_scope: 'CITY_WIDE',
  radius_km: 1,
  municipality_palika_string: 'Lalitpur Metropolitan City',
  min_order_value: 400,
  base_delivery_fee_npr: 80,
  fulfillment_mode: 'PLATFORM_FLEET',
  location: { x: 85.3188, y: 27.6795 },
});

export const NEW_ROAD_VENDOR = feedVendor({
  id: NEW_ROAD_VENDOR_ID,
  business_name: 'New Road Electronics',
  delivery_scope: 'CITY_WIDE',
  radius_km: 1,
  min_order_value: 1000,
  base_delivery_fee_npr: 100,
  location: { x: 85.31, y: 27.704 },
});

/** What the server answers from Thamel: two vendors deliver, Patan (Lalitpur) is browse-only. */
export function feedResponse(overrides: Partial<FeedResponse> = {}): FeedResponse {
  return feedResponseSchema.parse({
    serviceable: [
      { vendor: feedVendor(), distance_km: 0, serviceable: true },
      { vendor: NEW_ROAD_VENDOR, distance_km: 1.285, serviceable: true },
    ],
    explore_further: [{ vendor: PATAN_VENDOR, distance_km: 4.013, serviceable: false }],
    ...overrides,
  });
}

export const MUSTARD_OIL_ID = '7a2b3c40-0011-4000-8000-000000000004';

export function vendorMenu(overrides: Partial<VendorMenu> = {}): VendorMenu {
  return vendorMenuSchema.parse({
    vendor: feedVendor(),
    serviceable: true,
    products: [
      { id: NOODLES.id, name: NOODLES.name, price_npr: NOODLES.unitPriceNpr, in_stock: true },
      { id: RICE.id, name: RICE.name, price_npr: RICE.unitPriceNpr, in_stock: true },
      { id: MUSTARD_OIL_ID, name: 'Mustard Oil 1L', price_npr: 320, in_stock: false },
    ],
    ...overrides,
  });
}

/* ---------- Orders (GET /api/orders/:id, POST /api/orders/:id/cancel) ---------- */

export function orderSnapshot(overrides: Partial<OrderSnapshotView> = {}): OrderSnapshotView {
  return orderDetailResponseSchema.parse({
    order: {
      ...orderView({ state: 'PLACED', payment_method: 'COD' }),
      customer_id: '9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a',
      refund_required: false,
      placed_at: '2026-09-29T10:00:00.000Z',
      delivered_at: null,
      delivery_address: {
        province_id: THAMEL_ADDRESS.province_id,
        district_string: THAMEL_ADDRESS.district_string,
        municipality_palika_string: THAMEL_ADDRESS.municipality_palika_string,
        ward_number: THAMEL_ADDRESS.ward_number,
        tole_locality: THAMEL_ADDRESS.tole_locality,
        landmark: THAMEL_ADDRESS.landmark,
        exact_lat: THAMEL_ADDRESS.exact_lat,
        exact_lng: THAMEL_ADDRESS.exact_lng,
      },
      items: [
        { product_id: NOODLES.id, product_name: NOODLES.name, unit_price_npr: 600, quantity: 2 },
      ],
      ...overrides,
    },
  }).order;
}

export function orderDetailResponse(overrides: Partial<OrderSnapshotView> = {}) {
  return { order: orderSnapshot(overrides) };
}

export function cancelResponse(refundRequired = false): CancelOrderResponseBody {
  return cancelOrderResponseSchema.parse({
    order_id: ORDER_ID,
    state: 'CANCELED',
    refund_required: refundRequired,
  });
}
