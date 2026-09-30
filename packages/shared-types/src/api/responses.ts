import { z } from 'zod';

import { DISPUTE_EVIDENCE_CONTENT_TYPES } from '../domain/constants';
import { geoPointSchema, nepalPhoneSchema } from '../domain/entities';
import { chatMessageSchema } from '../realtime/chat-socket';
import {
  deliveryScopeSchema,
  fulfillmentModeSchema,
  orderStateSchema,
  paymentMethodSchema,
  paymentStatusSchema,
  reviewDirectionSchema,
  userRoleSchema,
  vendorFulfillmentModeSchema,
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
});
export type FeedResponse = z.infer<typeof feedResponseSchema>;

export const menuProductSchema = z.strictObject({
  /** The products.id to send as `product_id` at checkout. */
  id: z.uuid(),
  name: z.string().min(1),
  price_npr: z.number().positive(),
  in_stock: z.boolean(),
});
export type MenuProduct = z.infer<typeof menuProductSchema>;

/** GET /api/vendors/:id/products */
export const vendorMenuSchema = z.strictObject({
  vendor: feedVendorSchema,
  /** Whether the vendor delivers to the customer. False: browsing only, carts disabled. */
  serviceable: z.boolean(),
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
