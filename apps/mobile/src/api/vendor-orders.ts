import {
  vendorOrderDecisionResponseSchema,
  vendorOrderListResponseSchema,
  type VendorOrderDecisionResponseBody,
  type VendorOrderView,
} from '@hamro-pasal/shared-types';

import { apiRequest } from './http';

export const VENDOR_ORDERS_PATH = '/api/vendors/orders';

export type VendorOrderDecision = 'accept' | 'reject';

export function vendorOrderDecisionPath(orderId: string, decision: VendorOrderDecision): string {
  return `${VENDOR_ORDERS_PATH}/${encodeURIComponent(orderId)}/${decision}`;
}

/** GET /api/vendors/orders: the shop's open orders, new (PLACED) ones first. */
export async function fetchVendorOrders(): Promise<VendorOrderView[]> {
  const { orders } = await apiRequest({
    method: 'GET',
    path: VENDOR_ORDERS_PATH,
    schema: vendorOrderListResponseSchema,
  });
  return orders;
}

/**
 * POST /api/vendors/orders/:id/accept (→ PREPARING) or …/reject (→ CANCELED; a prepaid order's
 * escrow is flagged for refund by the server). Repeating a decision is harmless.
 */
export function decideVendorOrder(
  orderId: string,
  decision: VendorOrderDecision,
): Promise<VendorOrderDecisionResponseBody> {
  return apiRequest({
    method: 'POST',
    path: vendorOrderDecisionPath(orderId, decision),
    schema: vendorOrderDecisionResponseSchema,
  });
}
