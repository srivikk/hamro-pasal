import { z } from 'zod';

import { paymentMethodSchema } from '../domain/enums';
import { nepalAddressInputSchema } from '../localization/address';
import { NEPAL_BOUNDING_BOX } from '../nepal/geo';

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
  /** Where to deliver (Nepal hierarchy + dropped pin), stored with the order. */
  delivery_address: nepalAddressInputSchema,
});
export type CheckoutRequest = z.infer<typeof checkoutRequestSchema>;
export type CheckoutRequestInput = z.input<typeof checkoutRequestSchema>;

/** Query-string coordinate: parsed from text and limited to Nepal's bounding box (SPEC §1). */
const queryCoordinate = (field: string, min: number, max: number) =>
  z
    .string({ error: `${field} is required` })
    .trim()
    .min(1, `${field} is required`)
    .pipe(z.coerce.number({ error: `${field} must be a number` }))
    .pipe(z.number().min(min, `${field} is outside Nepal`).max(max, `${field} is outside Nepal`));

const customerLocationQueryShape = {
  lat: queryCoordinate('lat', NEPAL_BOUNDING_BOX.minLat, NEPAL_BOUNDING_BOX.maxLat),
  lng: queryCoordinate('lng', NEPAL_BOUNDING_BOX.minLng, NEPAL_BOUNDING_BOX.maxLng),
  /**
   * The customer's Palika (as in their address). CITY_WIDE vendors are serviceable only when it
   * matches theirs (SPEC §2). Without it no CITY_WIDE vendor can be shown as serviceable.
   */
  municipality_palika_string: z.string().trim().min(1).max(120).optional(),
};

/** GET /api/vendors?lat=&lng=[&municipality_palika_string=] (SPEC customer journey 3). */
export const vendorFeedQuerySchema = z.strictObject(customerLocationQueryShape);
export type VendorFeedQuery = z.output<typeof vendorFeedQuerySchema>;

/** GET /api/vendors/:id/products?lat=&lng=[&municipality_palika_string=] */
export const vendorMenuQuerySchema = z.strictObject(customerLocationQueryShape);
export type VendorMenuQuery = z.output<typeof vendorMenuQuerySchema>;

/** Route parameter `:id` of /api/vendors/:id/... and /api/orders/:id/... */
export const idParamSchema = z.strictObject({
  id: z.uuid(),
});

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
