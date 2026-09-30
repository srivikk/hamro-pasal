import {
  deliveryConfirmedResponseSchema,
  vendorOrderDecisionResponseSchema,
  vendorOrderDispatchResponseSchema,
  vendorOrderListResponseSchema,
  type DeliveryConfirmedResponseBody,
  type VendorOrderDecisionResponseBody,
  type VendorOrderDispatchResponseBody,
  type VendorOrderView,
} from '@hamro-pasal/shared-types';

import { deliveryOtpBody } from './delivery';
import { apiRequest } from './http';

export const VENDOR_ORDERS_PATH = '/api/vendors/orders';

export type VendorOrderDecision = 'accept' | 'reject';

/** Every POST the vendor dashboard sends about one order. */
export type VendorOrderAction = VendorOrderDecision | 'dispatch' | 'deliver';

export function vendorOrderDecisionPath(orderId: string, action: VendorOrderAction): string {
  return `${VENDOR_ORDERS_PATH}/${encodeURIComponent(orderId)}/${action}`;
}

/** Server code for a dispatch inside the customer's 60 s window (`details.retry_after_seconds`). */
export const CANCELLATION_WINDOW_OPEN = 'CANCELLATION_WINDOW_OPEN';

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

/**
 * POST /api/vendors/orders/:id/dispatch (vendor flow step 8): PREPARING → OUT_FOR_DELIVERY.
 * `422 CANCELLATION_WINDOW_OPEN` while the customer may still cancel. Repeating it is harmless.
 */
export function dispatchVendorOrder(orderId: string): Promise<VendorOrderDispatchResponseBody> {
  return apiRequest({
    method: 'POST',
    path: vendorOrderDecisionPath(orderId, 'dispatch'),
    schema: vendorOrderDispatchResponseSchema,
  });
}

/**
 * POST /api/vendors/orders/:id/deliver (vendor flow step 9): the shop's own staff hand over a
 * SELF_DELIVERY order with the customer's 4-digit code. Same rules as the rider's handoff; the
 * code is validated first and a malformed one is never sent.
 */
export async function deliverVendorOrder(
  orderId: string,
  deliveryOtp: string,
): Promise<DeliveryConfirmedResponseBody> {
  const body = deliveryOtpBody(deliveryOtp);
  return apiRequest({
    method: 'POST',
    path: vendorOrderDecisionPath(orderId, 'deliver'),
    body,
    schema: deliveryConfirmedResponseSchema,
  });
}
