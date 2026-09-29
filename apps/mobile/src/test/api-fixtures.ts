import {
  nepalAddressInputSchema,
  type NepalAddress,
  checkoutResponseSchema,
  lockStatusResponseSchema,
  type CheckoutResponseBody,
  type LockStatusResponseBody,
  type LockView,
  type OrderView,
} from '@hamro-pasal/shared-types';

import { MOCK_PRODUCTS_BY_VENDOR } from '../features/menu/mock-menu-api';
import type { CartProduct, CartVendor } from '../store/useCartStore';

/*
 * Server responses built through the shared-types response schemas, so a fixture can never drift
 * from the contract the real API is tested against (STATE_HANDOFF §8).
 */

export const ORDER_ID = '0b7e9c1a-2f4d-4c8e-9a6b-1d2e3f4a5b6c';
export const RESERVATION_ID = '5c6d7e8f-9a0b-4c1d-8e2f-3a4b5c6d7e8f';

/** Thamel Kirana Pasal and two of its mock products (uuid IDs, as the checkout API requires). */
export const THAMEL_VENDOR: CartVendor = {
  id: '6f1c2a10-0000-4000-8000-000000000011',
  name: 'Thamel Kirana Pasal',
  deliveryFeeNpr: 50,
  minOrderValueNpr: 500,
};

const thamelProducts = MOCK_PRODUCTS_BY_VENDOR[THAMEL_VENDOR.id] ?? [];
const toCartProduct = (index: number): CartProduct => {
  const product = thamelProducts[index];
  if (product === undefined) throw new Error(`No mock product ${String(index)}`);
  return { id: product.id, name: product.name, unitPriceNpr: product.price_npr };
};
export const NOODLES = toCartProduct(0); // Rs. 600
export const RICE = toCartProduct(1); // Rs. 1150

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
