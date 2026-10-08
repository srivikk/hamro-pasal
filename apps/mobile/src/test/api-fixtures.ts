import {
  authTokensResponseSchema,
  categoryListResponseSchema,
  productListResponseSchema,
  type CategoryListResponseBody,
  type CategoryView,
  type ProductListResponseBody,
  type PublicProduct,
  chatMessageSchema,
  disputeEvidenceUploadResponseSchema,
  deliveryConfirmedResponseSchema,
  deliveryListResponseSchema,
  reviewSubmitResponseSchema,
  cancelOrderResponseSchema,
  checkoutResponseSchema,
  feedResponseSchema,
  lockStatusResponseSchema,
  nepalAddressInputSchema,
  orderDetailResponseSchema,
  otpSendResponseSchema,
  vendorMenuSchema,
  vendorOrderDecisionResponseSchema,
  vendorOrderListResponseSchema,
  vendorWalletBalanceResponseSchema,
  vendorWalletLedgerEntrySchema,
  vendorWalletLedgerResponseSchema,
  type AuthTokensResponseBody,
  type ChatMessage,
  type DisputeEvidenceUploadResponseBody,
  type DeliveryConfirmedResponseBody,
  type DeliveryView,
  type ReviewView,
  type CancelOrderResponseBody,
  type CheckoutResponseBody,
  type FeedResponse,
  type FeedVendor,
  type LockStatusResponseBody,
  type LockView,
  type NepalAddress,
  type OrderSnapshotView,
  type OtpSendResponseBody,
  type OrderView,
  type MenuProduct,
  type VendorMenu,
  type VendorOrderDecisionResponseBody,
  type VendorOrderView,
  type VendorWalletBalanceResponseBody,
  type VendorWalletLedgerEntry,
  type VendorWalletLedgerResponseBody,
} from '@hamro-pasal/shared-types';

import type { z } from 'zod';

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
export function feedResponse(
  overrides: Partial<z.input<typeof feedResponseSchema>> = {},
): FeedResponse {
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

/** One menu line as the API sends it: the exact stock, and `in_stock` derived from it. */
export function menuProduct(
  id: string,
  name: string,
  priceNpr: number,
  stock: number,
): MenuProduct {
  return { id, name, price_npr: priceNpr, in_stock: stock > 0, stock_quantity: stock };
}

export function vendorMenu(overrides: Partial<VendorMenu> = {}): VendorMenu {
  return vendorMenuSchema.parse({
    vendor: feedVendor(),
    serviceable: true,
    products: [
      menuProduct(NOODLES.id, NOODLES.name, NOODLES.unitPriceNpr, 20),
      menuProduct(RICE.id, RICE.name, RICE.unitPriceNpr, 12),
      menuProduct(MUSTARD_OIL_ID, 'Mustard Oil 1L', 320, 0),
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

/* ---------- Auth (POST /api/auth/otp/send, POST /api/auth/otp/verify) ---------- */

export const TEST_PHONE = '+9779800000001';
export const ISSUED_ACCESS_TOKEN = 'eyJhbGciOiJIUzI1NiJ9.issued-access.signature';
export const ISSUED_REFRESH_TOKEN = 'eyJhbGciOiJIUzI1NiJ9.issued-refresh.signature';

export function otpSendResponse(phone = TEST_PHONE): OtpSendResponseBody {
  return otpSendResponseSchema.parse({ phone, expires_in_seconds: 120, resend_after_seconds: 60 });
}

export function authTokensResponse(isNewUser = false): AuthTokensResponseBody {
  return authTokensResponseSchema.parse({
    token_type: 'Bearer',
    access_token: ISSUED_ACCESS_TOKEN,
    access_token_expires_in: 900,
    refresh_token: ISSUED_REFRESH_TOKEN,
    refresh_token_expires_in: 604_800,
    user: { id: '9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a', role: 'CUSTOMER', first_name: null },
    is_new_user: isNewUser,
  });
}

/* ---------- Phase 9: reviews, dispute evidence, /chat acks ---------- */

export const REVIEW_ID = '3e4f5a6b-7c8d-4e9f-8a0b-1c2d3e4f5a6b';

/** POST /api/reviews 201 body. */
export function reviewResponse(overrides: Partial<ReviewView> = {}) {
  return reviewSubmitResponseSchema.parse({
    review: {
      id: REVIEW_ID,
      order_id: ORDER_ID,
      direction: 'CUSTOMER_TO_VENDOR',
      rating: 5,
      feedback: null,
      status: 'QUARANTINED',
      published_at: null,
      created_at: '2026-09-30T09:00:00.000Z',
      ...overrides,
    },
  });
}

/** POST /api/uploads/dispute-evidence 201 body (the local-dev storage URL shape). */
export function evidenceUpload(
  name = 'b1c2d3e4-f5a6-4b7c-8d9e-0f1a2b3c4d5e.jpg',
): DisputeEvidenceUploadResponseBody {
  return disputeEvidenceUploadResponseSchema.parse({
    url: `http://localhost:4000/uploads/dispute-evidence/${ORDER_ID}/${name}`,
    content_type: 'image/jpeg',
  });
}

/** A message exactly as the /chat server broadcasts it (and acks it to its sender). */
export function serverChatMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return chatMessageSchema.parse({
    id: '9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a',
    client_id: null,
    order_id: ORDER_ID,
    sender: { id: 'user-ram', first_name: 'Ram', role: 'VENDOR' },
    body: 'Sorry! Can you share a photo?',
    attachments: [],
    sent_at: '2026-09-30T10:00:00.000Z',
    ...overrides,
  });
}

/* ---------- Vendor orders (GET /api/vendors/orders, POST …/:id/accept | reject) ---------- */

export const NEW_ORDER_ID = '3e4f5a6b-7c8d-4e9f-8a0b-1c2d3e4f5a6b';
export const SECOND_ORDER_ID = '4f5a6b7c-8d9e-4f0a-9b1c-2d3e4f5a6b7c';

/** A PLACED COD order as the vendor dashboard receives it (no customer identity). */
export function vendorOrder(overrides: Partial<VendorOrderView> = {}): VendorOrderView {
  const [order] = vendorOrderListResponseSchema.parse({
    orders: [
      {
        ...orderView({ id: NEW_ORDER_ID, state: 'PLACED', payment_method: 'COD' }),
        placed_at: '2026-09-30T10:00:00.000Z',
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
          { product_id: RICE.id, product_name: RICE.name, unit_price_npr: 1150, quantity: 1 },
        ],
        ...overrides,
      },
    ],
  }).orders;
  if (order === undefined) throw new Error('unreachable');
  return order;
}

/** GET /api/vendors/orders 200 body. */
export function vendorOrderList(orders: VendorOrderView[]) {
  return vendorOrderListResponseSchema.parse({ orders });
}

/** POST /api/vendors/orders/:id/accept | reject 200 body. */
export function vendorDecision(
  orderId: string,
  state: 'PREPARING' | 'CANCELED',
  refundRequired = false,
): VendorOrderDecisionResponseBody {
  return vendorOrderDecisionResponseSchema.parse({
    order_id: orderId,
    state,
    refund_required: refundRequired,
  });
}

/* ---------- Deliveries (GET /api/deliveries, POST …/:id/accept | pickup | complete) ---------- */

export const DELIVERY_ID = '5d0f6c1e-2b7a-4c39-9e54-0a1b2c3d4e5f';
export const SECOND_DELIVERY_ID = '6e1a7d2f-3c8b-4d4a-8f65-1b2c3d4e5f6a';

/** An open gig for a COD fleet order out for delivery, as the rider's dashboard receives it. */
export function delivery(
  overrides: Partial<Omit<DeliveryView, 'order'>> & { order?: Partial<DeliveryView['order']> } = {},
): DeliveryView {
  const { order, ...rest } = overrides;
  const [parsed] = deliveryListResponseSchema.parse({
    deliveries: [
      {
        id: DELIVERY_ID,
        state: 'OFFERED',
        assigned_to_me: false,
        accepted_at: null,
        picked_up_at: null,
        ...rest,
        order: {
          ...orderView({
            id: NEW_ORDER_ID,
            state: 'OUT_FOR_DELIVERY',
            payment_method: 'COD',
            fulfillment: 'PLATFORM_FLEET',
          }),
          vendor_business_name: 'Patan Organic Store',
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
            {
              product_id: NOODLES.id,
              product_name: NOODLES.name,
              unit_price_npr: 600,
              quantity: 2,
            },
          ],
          ...order,
        },
      },
    ],
  }).deliveries;
  if (parsed === undefined) throw new Error('unreachable');
  return parsed;
}

/** The same delivery after this rider accepted it. */
export function acceptedDelivery(overrides: Parameters<typeof delivery>[0] = {}): DeliveryView {
  return delivery({
    state: 'ASSIGNED',
    assigned_to_me: true,
    accepted_at: '2026-10-03T10:30:00.000Z',
    ...overrides,
  });
}

/** The same delivery once the rider has the parcel: the code field shows. */
export function pickedUpDelivery(overrides: Parameters<typeof delivery>[0] = {}): DeliveryView {
  return acceptedDelivery({
    state: 'PICKED_UP',
    picked_up_at: '2026-10-03T10:40:00.000Z',
    ...overrides,
  });
}

/** GET /api/deliveries 200 body. */
export function deliveryList(deliveries: DeliveryView[]) {
  return deliveryListResponseSchema.parse({ deliveries });
}

/** POST /api/deliveries/:id/accept | pickup 200 body. */
export function deliveryBody(view: DeliveryView) {
  return { delivery: view };
}

/** POST /api/deliveries/:id/complete 200 body. */
export function deliveryCompleted(orderId: string): DeliveryConfirmedResponseBody {
  return deliveryConfirmedResponseSchema.parse({
    order_id: orderId,
    state: 'DELIVERED',
    delivered_at: '2026-09-30T10:45:00.000Z',
  });
}

/*
 * Vendor wallet (Phase 12).
 */

export const WALLET_VENDOR_ID = '5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d';

/** GET /api/vendors/wallet/balance: a healthy LIVE shop by default. */
export function walletBalance(
  overrides: Partial<VendorWalletBalanceResponseBody> = {},
): VendorWalletBalanceResponseBody {
  return vendorWalletBalanceResponseSchema.parse({
    vendor_id: WALLET_VENDOR_ID,
    status: 'LIVE',
    is_suspended: false,
    suspended_for_debt: false,
    wallet_balance_npr: 850,
    suspension_limit_npr: -2000,
    pending_escrow_npr: 0,
    pending_escrow_order_count: 0,
    ...overrides,
  });
}

/** One wallet posting: a COD self-delivery commission debit (1000 NPR at 10 %) by default. */
export function walletEntry(
  overrides: Partial<VendorWalletLedgerEntry> = {},
): VendorWalletLedgerEntry {
  return vendorWalletLedgerEntrySchema.parse({
    id: '6b7c8d9e-0f1a-4b2c-9d3e-4f5a6b7c8d9e',
    transaction_id: '7c8d9e0f-1a2b-4c3d-8e4f-5a6b7c8d9e0f',
    kind: 'ORDER_SETTLEMENT',
    entry_type: 'COD_COMMISSION_DEBIT',
    amount_npr: -100,
    balance_after_npr: -100,
    description: 'COD / SELF_DELIVERY settlement',
    created_at: '2026-09-30T10:00:00.000Z',
    order: {
      id: NEW_ORDER_ID,
      payment_method: 'COD',
      fulfillment: 'SELF_DELIVERY',
      subtotal_npr: 1000,
      delivery_fee_npr: 50,
      commission_npr: 100,
    },
    ...overrides,
  });
}

/** GET /api/vendors/wallet/ledger: one page. */
export function walletLedgerPage(
  entries: VendorWalletLedgerEntry[],
  nextCursor: string | null = null,
): VendorWalletLedgerResponseBody {
  return vendorWalletLedgerResponseSchema.parse({ entries, next_cursor: nextCursor });
}

/*
 * Phase 18: the public taxonomy and product list (GET /api/categories, GET /api/products).
 */

export const GROCERIES_ID = '8b3c4d50-0000-4000-8000-000000000001';
export const TEA_COFFEE_ID = '8b3c4d50-0000-4000-8000-000000000002';
export const ELECTRONICS_ID = '8b3c4d50-0000-4000-8000-000000000003';

/** Two roots (Groceries with one subcategory, Electronics), in the server's tree order. */
export function categoryList(
  categories: CategoryView[] = [
    category({ id: GROCERIES_ID, name: 'Groceries', slug: 'groceries' }),
    category({
      id: TEA_COFFEE_ID,
      name: 'Tea & Coffee',
      slug: 'tea-coffee',
      parent_id: GROCERIES_ID,
    }),
    category({ id: ELECTRONICS_ID, name: 'Electronics', slug: 'electronics', display_order: 1 }),
  ],
): CategoryListResponseBody {
  return categoryListResponseSchema.parse({ categories });
}

export function category(overrides: Partial<CategoryView> = {}): CategoryView {
  return {
    id: GROCERIES_ID,
    name: 'Groceries',
    slug: 'groceries',
    parent_id: null,
    icon_url: null,
    display_order: 0,
    ...overrides,
  };
}

export const TEA_ID = '7a2b3c40-0011-4000-8000-000000000003';
export const HONEY_ID = '7a2b3c40-0012-4000-8000-000000000001';

/** Ilam Tea of the Thamel shop (which delivers to the test customer), 12 in stock, by default. */
export function publicProduct(overrides: Partial<PublicProduct> = {}): PublicProduct {
  const stock = overrides.stock_quantity ?? 12;
  return {
    id: TEA_ID,
    vendor: { id: THAMEL_VENDOR.id, business_name: THAMEL_VENDOR.name },
    category_id: TEA_COFFEE_ID,
    name: 'Ilam Tea 500g',
    description: 'Orthodox black tea from Ilam.',
    price_npr: 450,
    unit: 'pack',
    in_stock: stock > 0,
    stock_quantity: stock,
    image_urls: [],
    metadata: {},
    ...overrides,
  };
}

/** GET /api/products: one page. */
export function productList(
  products: PublicProduct[] = [publicProduct()],
  nextCursor: string | null = null,
): ProductListResponseBody {
  return productListResponseSchema.parse({ products, next_cursor: nextCursor });
}
