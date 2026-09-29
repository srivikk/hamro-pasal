import { z } from 'zod';

import { feedVendorSchema } from '../feed/feed-contract';

/*
 * Vendor menu response. Like the feed, the backend has no catalog endpoint yet (STATE_HANDOFF §8),
 * so the contract lives here until it moves to @hamro-pasal/shared-types.
 */

export const menuProductSchema = z.strictObject({
  /** A uuid, because the checkout API requires `product_id` to be one. */
  id: z.uuid(),
  name: z.string().min(1),
  price_npr: z.number().positive(),
  in_stock: z.boolean(),
});
export type MenuProduct = z.infer<typeof menuProductSchema>;

export const vendorMenuSchema = z.strictObject({
  vendor: feedVendorSchema,
  /** Whether the vendor delivers to the customer. False: browsing only, carts disabled (SPEC step 3). */
  serviceable: z.boolean(),
  products: z.array(menuProductSchema),
});
export type VendorMenu = z.infer<typeof vendorMenuSchema>;
