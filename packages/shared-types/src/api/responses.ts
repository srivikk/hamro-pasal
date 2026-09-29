import { z } from 'zod';

import {
  fulfillmentModeSchema,
  orderStateSchema,
  paymentMethodSchema,
  paymentStatusSchema,
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
