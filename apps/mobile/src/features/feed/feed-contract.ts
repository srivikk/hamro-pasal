import {
  deliveryScopeSchema,
  geoPointSchema,
  vendorFulfillmentModeSchema,
} from '@hamro-pasal/shared-types';
import { z } from 'zod';

/*
 * Feed response contract. The backend has no feed endpoint yet (STATE_HANDOFF §8), so this lives
 * in the app for now; move it to @hamro-pasal/shared-types `api/responses.ts` when the endpoint
 * is built, and the mock in `mock-feed-api.ts` can then be swapped for a real fetch.
 */

export const feedVendorSchema = z.strictObject({
  id: z.string().min(1),
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
  distance_km: z.number().nonnegative(),
  serviceable: z.boolean(),
});
export type FeedEntry = z.infer<typeof feedEntrySchema>;

export const feedResponseSchema = z.strictObject({
  /** Vendors that deliver to the customer, nearest first. */
  serviceable: z.array(feedEntrySchema),
  /** SPEC customer flow step 3: shown desaturated under "Explore Further" with carts disabled. */
  explore_further: z.array(feedEntrySchema),
});
export type FeedResponse = z.infer<typeof feedResponseSchema>;
