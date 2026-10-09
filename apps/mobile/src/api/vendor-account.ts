import {
  vendorDeactivateResponseSchema,
  vendorDeactivationBlockerSchema,
  type VendorDeactivateResponseBody,
  type VendorDeactivationBlocker,
} from '@hamro-pasal/shared-types';
import { z } from 'zod';

import { ApiError, apiRequest } from './http';

export const VENDOR_DEACTIVATE_PATH = '/api/vendor/account/deactivate';
export const SHOP_NOT_DEACTIVATABLE = 'SHOP_NOT_DEACTIVATABLE';

/**
 * POST /api/vendor/account/deactivate: closes the signed-in vendor's own shop. Final for the
 * vendor: the account can no longer sign in, and only Hamro Pasal can reopen the shop.
 */
export function deactivateShop(): Promise<VendorDeactivateResponseBody> {
  return apiRequest({
    method: 'POST',
    path: VENDOR_DEACTIVATE_PATH,
    body: { confirm: true },
    schema: vendorDeactivateResponseSchema,
  });
}

const blockersSchema = z.object({ blockers: z.array(vendorDeactivationBlockerSchema).min(1) });

/** What the server says stands in the way (409 SHOP_NOT_DEACTIVATABLE); null for any other error. */
export function deactivationBlockersOf(error: unknown): VendorDeactivationBlocker[] | null {
  if (!(error instanceof ApiError) || error.code !== SHOP_NOT_DEACTIVATABLE) return null;
  const details = blockersSchema.safeParse(error.details);
  return details.success ? details.data.blockers : null;
}
