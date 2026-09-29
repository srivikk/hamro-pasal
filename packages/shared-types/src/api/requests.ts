import { z } from 'zod';

import { paymentMethodSchema } from '../domain/enums';

/*
 * HTTP request contracts for apps/api, shared with the mobile client so both sides validate
 * with the same rules.
 */

export const MAX_CART_LINES = 50;
export const MAX_LINE_QUANTITY = 99;

/** POST /api/cart/checkout. Locks the cart for 600 s and creates the order (SPEC §3, journey 6). */
export const checkoutRequestSchema = z.strictObject({
  /** Client-generated per checkout attempt; resubmitting it returns the same order. */
  idempotency_key: z.string().trim().min(8).max(100),
  vendor_id: z.uuid(),
  payment_method: paymentMethodSchema,
  items: z
    .array(
      z.strictObject({
        product_id: z.uuid(),
        quantity: z.number().int().min(1).max(MAX_LINE_QUANTITY),
      }),
    )
    .min(1)
    .max(MAX_CART_LINES),
});
export type CheckoutRequest = z.infer<typeof checkoutRequestSchema>;

/** GET /api/cart/lock-status?order_id=... (SPEC edge case 1: resume or purge after reconnect). */
export const lockStatusQuerySchema = z.strictObject({
  order_id: z.uuid(),
});

/** POST /api/payments/{esewa,khalti}/initiate */
export const paymentInitiateRequestSchema = z.strictObject({
  order_id: z.uuid(),
});

/** POST /api/payments/esewa/webhook: the base64 `data` eSewa appends to the success redirect. */
export const esewaWebhookRequestSchema = z.strictObject({
  data: z
    .string()
    .min(1)
    .max(4096)
    .regex(/^[A-Za-z0-9+/=_-]+$/, 'data must be base64'),
});

/** POST /api/payments/khalti/lookup: the pidx from Khalti's return_url callback. */
export const khaltiLookupRequestSchema = z.strictObject({
  pidx: z.string().trim().min(1).max(100),
});
