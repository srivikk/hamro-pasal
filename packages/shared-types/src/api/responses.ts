import { z } from 'zod';

import { DISPUTE_EVIDENCE_CONTENT_TYPES } from '../domain/constants';
import { geoPointSchema, nepalPhoneSchema } from '../domain/entities';
import { chatMessageSchema } from '../realtime/chat-socket';
import {
  deliveryScopeSchema,
  fulfillmentModeSchema,
  ledgerTransactionKindSchema,
  orderStateSchema,
  paymentMethodSchema,
  paymentStatusSchema,
  reviewDirectionSchema,
  userRoleSchema,
  vendorFulfillmentModeSchema,
  vendorStatusSchema,
} from '../domain/enums';

/*
 * HTTP response contracts of apps/api. The server builds these bodies (apps/api/src/routes) and
 * the mobile client can validate them at runtime with the same schemas. Field names are
 * snake_case, like the rest of the wire format.
 */

/**
 * Every non-2xx response from apps/api: `{ error: { code, message, details? } }`.
 * `code` is a stable machine-readable identifier (e.g. RESERVATION_EXPIRED, INSUFFICIENT_STOCK)
 * for the client to branch on. `message` is for logs and debugging, not for display.
 * `details` is code-specific (e.g. shortfalls for INSUFFICIENT_STOCK).
 */
export const errorBodySchema = z.strictObject({
  error: z.strictObject({
    code: z.string().min(1),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});
export type ErrorBody = z.infer<typeof errorBodySchema>;

/** Public order representation: never exposes the OTP hash, gateway refs or commission. */
export const orderViewSchema = z.strictObject({
  id: z.uuid(),
  vendor_id: z.uuid(),
  state: orderStateSchema,
  payment_method: paymentMethodSchema,
  payment_status: paymentStatusSchema,
  fulfillment: fulfillmentModeSchema,
  subtotal_npr: z.number(),
  delivery_fee_npr: z.number(),
  total_npr: z.number(),
  created_at: z.iso.datetime(),
});
export type OrderView = z.infer<typeof orderViewSchema>;

/**
 * State of an order's 600 s inventory lock (SPEC §3, edge case 1):
 * ACTIVE resume checkout · EXPIRED purge the cart ("Session Expired") · RELEASED the order left
 * checkout (placed or closed).
 */
export const lockStatuses = ['ACTIVE', 'EXPIRED', 'RELEASED'] as const;
export const lockStatusSchema = z.enum(lockStatuses);
export type LockStatus = z.infer<typeof lockStatusSchema>;

export const lockViewSchema = z.strictObject({
  status: lockStatusSchema,
  ttl_ms: z.number().int().nonnegative(),
  expires_at: z.iso.datetime().nullable(),
});
export type LockView = z.infer<typeof lockViewSchema>;

export const paymentViewSchema = z.strictObject({
  order_id: z.uuid(),
  order_state: orderStateSchema,
  payment_status: paymentStatusSchema,
  /** true when this confirmation repeated one that had already credited escrow. */
  duplicate: z.boolean(),
});
export type PaymentView = z.infer<typeof paymentViewSchema>;

/** POST /api/cart/checkout: 201 (new order) or 200 (idempotent replay). */
export const checkoutResponseSchema = z.strictObject({
  order: orderViewSchema,
  reservation: z.strictObject({
    id: z.uuid().nullable(),
    expires_at: z.iso.datetime().nullable(),
  }),
  /**
   * Raw 4-digit handoff OTP; stored server-side only as a bcrypt hash. A replay rotates it, so
   * keep only the latest value. Null once the order no longer needs one.
   */
  delivery_otp: z
    .string()
    .regex(/^\d{4}$/)
    .nullable(),
  replayed: z.boolean(),
});
export type CheckoutResponseBody = z.infer<typeof checkoutResponseSchema>;

/** GET /api/cart/lock-status?order_id= */
export const lockStatusResponseSchema = z.strictObject({
  order: orderViewSchema,
  lock: lockViewSchema,
});
export type LockStatusResponseBody = z.infer<typeof lockStatusResponseSchema>;

/** POST /api/payments/esewa/initiate: auto-submit `fields` as an HTML form to `payment_url`. */
export const esewaInitiateResponseSchema = z.strictObject({
  payment_url: z.url(),
  method: z.literal('POST'),
  fields: z.record(z.string(), z.string()),
});
export type EsewaInitiateResponseBody = z.infer<typeof esewaInitiateResponseSchema>;

/** POST /api/payments/khalti/initiate: open `payment_url` in the browser. */
export const khaltiInitiateResponseSchema = z.strictObject({
  pidx: z.string().min(1),
  payment_url: z.url(),
  /** As reported by Khalti (ISO 8601 with offset), when it reports one. */
  expires_at: z.string().nullable(),
});
export type KhaltiInitiateResponseBody = z.infer<typeof khaltiInitiateResponseSchema>;

/** POST /api/payments/esewa/webhook and POST /api/payments/khalti/lookup */
export const paymentStatusResponseSchema = z.strictObject({
  /** Gateway status as reported (eSewa: COMPLETE/PENDING/...; Khalti: Completed/Pending/...). */
  status: z.string().min(1),
  /** Null unless the gateway reported a completed payment. */
  payment: paymentViewSchema.nullable(),
});
export type PaymentStatusResponseBody = z.infer<typeof paymentStatusResponseSchema>;

/*
 * Customer feed and vendor menus (SPEC §2, customer journey 3). The shapes match the drafts the
 * mobile app was built against (apps/mobile/src/features/{feed,menu}/*-contract.ts).
 */

/** The public profile of a LIVE vendor, enough to evaluate and display serviceability. */
export const feedVendorSchema = z.strictObject({
  id: z.uuid(),
  business_name: z.string().min(1),
  delivery_scope: deliveryScopeSchema,
  radius_km: z.number().positive(),
  municipality_palika_string: z.string().min(1),
  min_order_value: z.number().nonnegative(),
  base_delivery_fee_npr: z.number().nonnegative(),
  fulfillment_mode: vendorFulfillmentModeSchema,
  location: geoPointSchema,
});
export type FeedVendor = z.infer<typeof feedVendorSchema>;

export const feedEntrySchema = z.strictObject({
  vendor: feedVendorSchema,
  /** Geodesic (WGS 84 spheroid) distance from the customer's position. */
  distance_km: z.number().nonnegative(),
  serviceable: z.boolean(),
  /**
   * False while the Super Admin has this shop's delivery mode switched off: the shop is forced
   * Offline (closed, carts disabled) whatever the customer's location. Derived on every read.
   */
  delivery_available: z.boolean().default(true),
  /**
   * True on at most two entries, placed first in the serviceable section: shops with a running
   * FEED_LISTING ad purchase that deliver here (SPEC core 8). The app shows its "Ad" badge on
   * exactly these. Defaults to false, so a response from before the field reads as "not an ad".
   */
  is_sponsored: z.boolean().default(false),
});
export type FeedEntry = z.infer<typeof feedEntrySchema>;

/** GET /api/vendors */
export const feedResponseSchema = z.strictObject({
  /** Vendors that deliver to the customer, nearest first. */
  serviceable: z.array(feedEntrySchema),
  /**
   * LIVE vendors that do not deliver to the customer, nearest first. SPEC customer journey 3
   * shows them desaturated under "Explore Further" with carts disabled.
   */
  explore_further: z.array(feedEntrySchema),
  /**
   * False during the global Emergency Stop (both delivery modes switched off): no shop can take
   * an order and the app shows "Delivery Unavailable". Both sections are then empty.
   */
  delivery_available: z.boolean().default(true),
});
export type FeedResponse = z.infer<typeof feedResponseSchema>;

export const menuProductSchema = z.strictObject({
  /** The products.id to send as `product_id` at checkout. */
  id: z.uuid(),
  name: z.string().min(1),
  price_npr: z.number().positive(),
  in_stock: z.boolean(),
  /**
   * The vendor's on-hand count (Phase 19), so the app can cap what a cart line may hold, as the
   * public product list does. Other customers' 600 s checkout locks are not subtracted.
   */
  stock_quantity: z.number().int().nonnegative(),
});
export type MenuProduct = z.infer<typeof menuProductSchema>;

/** GET /api/vendors/:id/products */
export const vendorMenuSchema = z.strictObject({
  vendor: feedVendorSchema,
  /** Whether the vendor delivers to the customer. False: browsing only, carts disabled. */
  serviceable: z.boolean(),
  /**
   * False while this shop's delivery mode is switched off by the Super Admin (always, during
   * the Emergency Stop). The menu can be browsed; nothing can be ordered.
   */
  delivery_available: z.boolean().default(true),
  products: z.array(menuProductSchema),
});
export type VendorMenu = z.infer<typeof vendorMenuSchema>;

/*
 * Order detail and cancellation (customer journeys 8 and 9).
 */

/** The delivery address stored with an order (Nepal hierarchy, SPEC Nepal §3). */
export const orderAddressViewSchema = z.strictObject({
  province_id: z.number().int(),
  district_string: z.string().min(1),
  municipality_palika_string: z.string().min(1),
  ward_number: z.number().int().positive(),
  tole_locality: z.string().min(1),
  landmark: z.string().min(1),
  exact_lat: z.number(),
  exact_lng: z.number(),
});
export type OrderAddressView = z.infer<typeof orderAddressViewSchema>;

export const orderItemViewSchema = z.strictObject({
  product_id: z.uuid(),
  /** Name and price as they were at checkout. */
  product_name: z.string().min(1),
  unit_price_npr: z.number().positive(),
  quantity: z.number().int().positive(),
});
export type OrderItemView = z.infer<typeof orderItemViewSchema>;

/**
 * The customer's full view of an order (SPEC OrderSnapshot). Like OrderView, it never exposes
 * the OTP hash, gateway refs or the vendor's commission.
 */
export const orderSnapshotSchema = orderViewSchema.extend({
  customer_id: z.uuid(),
  /** A PAID order was canceled and its payment is due back to the customer. */
  refund_required: z.boolean(),
  /** When the order became PLACED; the 60 s cancellation window runs from here. */
  placed_at: z.iso.datetime().nullable(),
  delivered_at: z.iso.datetime().nullable(),
  /** Null only for orders created before checkout required an address. */
  delivery_address: orderAddressViewSchema.nullable(),
  items: z.array(orderItemViewSchema).min(1),
});
export type OrderSnapshotView = z.infer<typeof orderSnapshotSchema>;

/** GET /api/orders/:id */
export const orderDetailResponseSchema = z.strictObject({
  order: orderSnapshotSchema,
});
export type OrderDetailResponseBody = z.infer<typeof orderDetailResponseSchema>;

/** POST /api/orders/:id/cancel. Repeating a successful cancel returns the same body. */
export const cancelOrderResponseSchema = z.strictObject({
  order_id: z.uuid(),
  state: z.literal('CANCELED'),
  /** true for prepaid (PAID) orders: the refund is issued asynchronously. */
  refund_required: z.boolean(),
});
export type CancelOrderResponseBody = z.infer<typeof cancelOrderResponseSchema>;

/*
 * Vendor order management (vendor flow steps 6–8).
 */

/**
 * One of the vendor's orders, as the dashboard shows it: what to pack and where it goes. Like the
 * other views it never exposes the OTP hash, gateway refs or commission, and it carries no customer
 * name or phone.
 */
export const vendorOrderSchema = orderViewSchema.extend({
  /** When the order became PLACED: the alarm and the 90 s escalation run from here. */
  placed_at: z.iso.datetime(),
  /** Null only for orders created before checkout required an address. */
  delivery_address: orderAddressViewSchema.nullable(),
  items: z.array(orderItemViewSchema).min(1),
});
export type VendorOrderView = z.infer<typeof vendorOrderSchema>;

/**
 * GET /api/vendors/orders: the vendor's open orders (PLACED, then PREPARING, then its own
 * SELF_DELIVERY orders OUT_FOR_DELIVERY), oldest first within each.
 */
export const vendorOrderListResponseSchema = z.strictObject({
  orders: z.array(vendorOrderSchema),
});
export type VendorOrderListResponseBody = z.infer<typeof vendorOrderListResponseSchema>;

/**
 * POST /api/vendors/orders/:id/accept (→ PREPARING) and …/reject (→ CANCELED). Repeating a
 * decision returns the same body.
 */
export const vendorOrderDecisionResponseSchema = z.strictObject({
  order_id: z.uuid(),
  state: z.enum(['PREPARING', 'CANCELED']),
  /** true when a rejected order was prepaid (PAID): its escrow is refunded asynchronously. */
  refund_required: z.boolean(),
});
export type VendorOrderDecisionResponseBody = z.infer<typeof vendorOrderDecisionResponseSchema>;

/**
 * POST /api/vendors/orders/:id/dispatch (vendor flow step 8): PREPARING → OUT_FOR_DELIVERY.
 * Repeating it returns the same body.
 */
export const vendorOrderDispatchResponseSchema = z.strictObject({
  order_id: z.uuid(),
  state: z.literal('OUT_FOR_DELIVERY'),
});
export type VendorOrderDispatchResponseBody = z.infer<typeof vendorOrderDispatchResponseSchema>;

/*
 * Delivery partner (platform fleet) flow.
 */

/**
 * The order of a delivery, as the rider sees it: the shop it comes from, where it goes, what is
 * in it and how it is paid (for COD, `total_npr` is the cash to collect). Never the OTP hash,
 * gateway refs, commission, or the customer's name or phone.
 */
export const deliveryOrderSchema = orderViewSchema.extend({
  state: z.literal('OUT_FOR_DELIVERY'),
  vendor_business_name: z.string().min(1),
  /** Null only for orders created before checkout required an address. */
  delivery_address: orderAddressViewSchema.nullable(),
  items: z.array(orderItemViewSchema).min(1),
});
export type DeliveryOrderView = z.infer<typeof deliveryOrderSchema>;

/** A delivery a rider can still act on: an open gig (OFFERED) or one of their own. */
export const deliveryViewSchema = z.strictObject({
  id: z.uuid(),
  state: z.enum(['OFFERED', 'ASSIGNED', 'PICKED_UP']),
  /** false for an open gig any rider may accept. */
  assigned_to_me: z.boolean(),
  accepted_at: z.iso.datetime().nullable(),
  picked_up_at: z.iso.datetime().nullable(),
  order: deliveryOrderSchema,
});
export type DeliveryView = z.infer<typeof deliveryViewSchema>;

/** GET /api/deliveries: open gigs and the rider's own deliveries, oldest dispatch first. */
export const deliveryListResponseSchema = z.strictObject({
  deliveries: z.array(deliveryViewSchema),
});
export type DeliveryListResponseBody = z.infer<typeof deliveryListResponseSchema>;

/** POST /api/deliveries/:id/accept and …/pickup. Repeating either returns the same body. */
export const deliveryResponseSchema = z.strictObject({ delivery: deliveryViewSchema });
export type DeliveryResponseBody = z.infer<typeof deliveryResponseSchema>;

/**
 * POST /api/deliveries/:id/complete and /api/vendors/orders/:id/deliver: the code matched; the
 * order is DELIVERED and settled.
 */
export const deliveryConfirmedResponseSchema = z.strictObject({
  order_id: z.uuid(),
  state: z.literal('DELIVERED'),
  delivered_at: z.iso.datetime(),
});
export type DeliveryConfirmedResponseBody = z.infer<typeof deliveryConfirmedResponseSchema>;

/*
 * OTP authentication (SPEC implicit requirement 3).
 */

/** POST /api/auth/otp/send */
export const otpSendResponseSchema = z.strictObject({
  phone: nepalPhoneSchema,
  /** How long the code is valid (OTP_TTL_SECONDS). */
  expires_in_seconds: z.number().int().positive(),
  /** When a new code may be requested (OTP_RESEND_COOLDOWN_SECONDS). */
  resend_after_seconds: z.number().int().nonnegative(),
});
export type OtpSendResponseBody = z.infer<typeof otpSendResponseSchema>;

export const authUserSchema = z.strictObject({
  id: z.uuid(),
  role: userRoleSchema,
  /** Null until the customer adds a name; OTP sign-up only knows the phone number. */
  first_name: z.string().min(1).nullable(),
});
export type AuthUser = z.infer<typeof authUserSchema>;

/**
 * POST /api/auth/otp/verify. The access token (15 min) is kept in memory by the client; the
 * refresh token (7 days) only in encrypted storage.
 */
export const authTokensResponseSchema = z.strictObject({
  token_type: z.literal('Bearer'),
  access_token: z.string().min(1),
  access_token_expires_in: z.number().int().positive(),
  refresh_token: z.string().min(1),
  refresh_token_expires_in: z.number().int().positive(),
  user: authUserSchema,
  /** true when this verification created the customer account. */
  is_new_user: z.boolean(),
});
export type AuthTokensResponseBody = z.infer<typeof authTokensResponseSchema>;

/**
 * POST /api/auth/token/refresh: a new 15-minute access token. The refresh token itself is not
 * rotated; it stays valid until its own 7-day expiry.
 */
export const tokenRefreshResponseSchema = z.strictObject({
  token_type: z.literal('Bearer'),
  access_token: z.string().min(1),
  access_token_expires_in: z.number().int().positive(),
});
export type TokenRefreshResponseBody = z.infer<typeof tokenRefreshResponseSchema>;

/**
 * POST /api/auth/otp/verify for a SUPER_ADMIN (Phase 16): the same body without `refresh_token`.
 * The refresh token travels only in the HttpOnly, Secure, SameSite=Strict cookie set by the same
 * response, so no script can read it.
 */
export const cookieAuthTokensResponseSchema = authTokensResponseSchema.omit({
  refresh_token: true,
});
export type CookieAuthTokensResponseBody = z.infer<typeof cookieAuthTokensResponseSchema>;

/** POST /api/auth/otp/verify as a browser sees it: either shape, depending on the account's role. */
export const otpVerifyResponseSchema = z.union([
  authTokensResponseSchema,
  cookieAuthTokensResponseSchema,
]);
export type OtpVerifyResponseBody = z.infer<typeof otpVerifyResponseSchema>;

/**
 * POST /api/auth/refresh: a new 15-minute access token for the refresh cookie, with the account it
 * belongs to (a reloaded dashboard knows nothing else about its session). The cookie is not rotated.
 */
export const sessionRefreshResponseSchema = z.strictObject({
  token_type: z.literal('Bearer'),
  access_token: z.string().min(1),
  access_token_expires_in: z.number().int().positive(),
  user: authUserSchema.extend({ phone: nepalPhoneSchema }),
});
export type SessionRefreshResponseBody = z.infer<typeof sessionRefreshResponseSchema>;

/*
 * Double-blind reviews (SPEC §6).
 */

/**
 * QUARANTINED: stored with is_published = false and hidden from the other side. PUBLISHED: both
 * sides have reviewed the order, or 48 hours have passed since delivery.
 */
export const reviewStatuses = ['QUARANTINED', 'PUBLISHED'] as const;
export const reviewStatusSchema = z.enum(reviewStatuses);
export type ReviewStatus = z.infer<typeof reviewStatusSchema>;

export const reviewViewSchema = z.strictObject({
  id: z.uuid(),
  order_id: z.uuid(),
  direction: reviewDirectionSchema,
  rating: z.number().int().min(1).max(5),
  feedback: z.string().min(1).nullable(),
  status: reviewStatusSchema,
  published_at: z.iso.datetime().nullable(),
  created_at: z.iso.datetime(),
});
export type ReviewView = z.infer<typeof reviewViewSchema>;

/** POST /api/reviews (201). */
export const reviewSubmitResponseSchema = z.strictObject({
  review: reviewViewSchema,
});
export type ReviewSubmitResponseBody = z.infer<typeof reviewSubmitResponseSchema>;

/**
 * POST /api/uploads/dispute-evidence (201): where the stored image is served. The body is a valid
 * chat attachment, sent as is with `chat:new_message`.
 */
export const disputeEvidenceUploadResponseSchema = z.strictObject({
  url: z.url({ protocol: /^https?$/ }),
  content_type: z.enum(DISPUTE_EVIDENCE_CONTENT_TYPES),
});
export type DisputeEvidenceUploadResponseBody = z.infer<typeof disputeEvidenceUploadResponseSchema>;

/**
 * GET /api/orders/:id/chat: the dispute transcript, oldest first. Each message is exactly what the
 * /chat namespace broadcast (same ids, times and privacy-filtered senders). Empty when the order
 * has no dispute yet.
 */
export const chatHistoryResponseSchema = z.strictObject({
  messages: z.array(chatMessageSchema),
});
export type ChatHistoryResponseBody = z.infer<typeof chatHistoryResponseSchema>;

/*
 * Vendor wallet (Phase 12, SPEC §5 Financial Governance).
 */

/**
 * GET /api/vendors/wallet/balance. `wallet_balance_npr` is the vendor's VENDOR_WALLET ledger
 * balance (negative while the vendor owes COD commission). `pending_escrow_npr` is what the vendor
 * will be credited for prepaid orders whose money is still held in SYSTEM_ESCROW (paid, not yet
 * delivered): subtotal − commission, plus the delivery fee on SELF_DELIVERY orders.
 */
export const vendorWalletBalanceResponseSchema = z.strictObject({
  vendor_id: z.uuid(),
  status: vendorStatusSchema,
  /** status === 'SUSPENDED': the shop is offline. */
  is_suspended: z.boolean(),
  /**
   * Suspended because of wallet debt (Phase 12.5): paying until the balance is 0 or more restores the
   * shop. False for any other suspension, which a top-up does not lift.
   */
  suspended_for_debt: z.boolean(),
  wallet_balance_npr: z.number(),
  /** The Super Admin's limit (−2000 … 0): a balance strictly below it suspends the vendor. */
  suspension_limit_npr: z.number().max(0),
  pending_escrow_npr: z.number().nonnegative(),
  pending_escrow_order_count: z.number().int().nonnegative(),
});
export type VendorWalletBalanceResponseBody = z.infer<typeof vendorWalletBalanceResponseSchema>;

/**
 * What one wallet posting means to the vendor:
 * - ORDER_PAYOUT: an order's settlement credited the vendor (subtotal − commission [+ fee]).
 * - COD_COMMISSION_DEBIT: a COD self-delivery settlement debited the platform commission the vendor
 *   collected in cash (SPEC §5 "The COD Problem").
 * - TOP_UP: the vendor paid dues upfront (eSewa).
 * - ADJUSTMENT: a Super Admin correction.
 * - PAYOUT_HOLD: the vendor requested a bank withdrawal; the amount left the wallet (Phase 22).
 * - PAYOUT_REVERSAL: that request was rejected; the amount came back.
 * - AD_CHARGE: the shop's own ad purchase was charged, or its per-order budget held (Phase 28).
 * - AD_REFUND: an unused ad budget, or a flat-rate ad cancelled before it started, came back.
 */
export const walletEntryTypes = [
  'ORDER_PAYOUT',
  'COD_COMMISSION_DEBIT',
  'TOP_UP',
  'ADJUSTMENT',
  'PAYOUT_HOLD',
  'PAYOUT_REVERSAL',
  'AD_CHARGE',
  'AD_REFUND',
] as const;
export const walletEntryTypeSchema = z.enum(walletEntryTypes);
export type WalletEntryType = z.infer<typeof walletEntryTypeSchema>;

/** The order a settlement posting belongs to, with the amounts it was split from. */
export const walletEntryOrderSchema = z.strictObject({
  id: z.uuid(),
  payment_method: paymentMethodSchema,
  fulfillment: fulfillmentModeSchema,
  subtotal_npr: z.number(),
  delivery_fee_npr: z.number(),
  commission_npr: z.number(),
});

/** One posting to the vendor's wallet account. */
export const vendorWalletLedgerEntrySchema = z.strictObject({
  /** The ledger entry id; also the pagination cursor. */
  id: z.uuid(),
  transaction_id: z.uuid(),
  kind: ledgerTransactionKindSchema,
  entry_type: walletEntryTypeSchema,
  /** Signed change to the wallet (never 0). */
  amount_npr: z.number().refine((amount) => amount !== 0, 'amount_npr cannot be 0'),
  /** The wallet balance right after this posting. */
  balance_after_npr: z.number(),
  description: z.string().nullable(),
  created_at: z.iso.datetime(),
  order: walletEntryOrderSchema.nullable(),
});
export type VendorWalletLedgerEntry = z.infer<typeof vendorWalletLedgerEntrySchema>;

/** GET /api/vendors/wallet/ledger: one page, newest first; `next_cursor` null on the last page. */
export const vendorWalletLedgerResponseSchema = z.strictObject({
  entries: z.array(vendorWalletLedgerEntrySchema),
  next_cursor: z.uuid().nullable(),
});
export type VendorWalletLedgerResponseBody = z.infer<typeof vendorWalletLedgerResponseSchema>;

/**
 * POST /api/vendors/wallet/top-up: 201 for a new top-up, 200 (`replayed: true`) when the same
 * idempotency key is sent again. `restored` is true only on the request whose credit lifted a debt
 * suspension (the vendor is back in its previous status).
 */
export const walletTopUpResponseSchema = z.strictObject({
  transaction_id: z.uuid(),
  amount_npr: z.number().positive(),
  wallet_balance_npr: z.number(),
  status: vendorStatusSchema,
  is_suspended: z.boolean(),
  restored: z.boolean(),
  replayed: z.boolean(),
});
export type WalletTopUpResponseBody = z.infer<typeof walletTopUpResponseSchema>;

const quoteDiscountSchema = z.strictObject({
  id: z.uuid(),
  label: z.string().min(1),
  discount_npr: z.number().positive(),
});

/**
 * POST /api/cart/quote (SPEC core 9): the cart as checkout will price it, and the payment methods
 * checkout will accept. `total = subtotal - vendor_offer - platform_promo + delivery_fee`.
 */
export const cartQuoteResponseSchema = z.strictObject({
  subtotal_npr: z.number().min(0),
  /** Null until vendor offers and platform campaigns exist (no discount is applied today). */
  vendor_offer: quoteDiscountSchema.nullable(),
  platform_promo: quoteDiscountSchema.nullable(),
  delivery_fee_npr: z.number().min(0),
  /** Shop to delivery pin, great-circle, rounded to the metre. */
  distance_km: z.number().min(0),
  total_npr: z.number().min(0),
  /**
   * False when the order cannot be placed because delivery is switched off: the Emergency Stop,
   * or this shop's own delivery mode. The cart is still priced; every payment option is then
   * unavailable and checkout answers 422.
   */
  delivery_available: z.boolean().default(true),
  payment_options: z.array(
    z.strictObject({
      method: paymentMethodSchema,
      available: z.boolean(),
      reason: z
        .enum(['NOT_ACCEPTED_BY_SHOP', 'COD_NOT_AVAILABLE', 'DELIVERY_UNAVAILABLE'])
        .optional(),
    }),
  ),
});
export type CartQuoteResponseBody = z.infer<typeof cartQuoteResponseSchema>;
