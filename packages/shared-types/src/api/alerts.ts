import { z } from 'zod';

/*
 * Step 7.4 (SPEC core 11): Notify Me. A signed-in customer asks to be told once when an
 * out-of-stock product is back, or when a closed or offline shop next opens.
 */

/** PUT and DELETE /api/me/alerts/{products,shops}/:id. */
export const alertResponseSchema = z.strictObject({
  alerted: z.boolean(),
});
export type AlertResponseBody = z.infer<typeof alertResponseSchema>;

export const productAlertViewSchema = z.strictObject({
  product_id: z.uuid(),
  product_name: z.string().min(1),
  vendor_id: z.uuid(),
  business_name: z.string().min(1),
  created_at: z.iso.datetime(),
});
export type ProductAlertView = z.infer<typeof productAlertViewSchema>;

export const shopAlertViewSchema = z.strictObject({
  vendor_id: z.uuid(),
  business_name: z.string().min(1),
  created_at: z.iso.datetime(),
});
export type ShopAlertView = z.infer<typeof shopAlertViewSchema>;

/** GET /api/me/alerts: what the customer is waiting for, newest first. */
export const alertListResponseSchema = z.strictObject({
  products: z.array(productAlertViewSchema),
  shops: z.array(shopAlertViewSchema),
});
export type AlertListResponseBody = z.infer<typeof alertListResponseSchema>;
