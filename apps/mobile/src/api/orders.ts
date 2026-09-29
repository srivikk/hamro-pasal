import {
  cancelOrderResponseSchema,
  orderDetailResponseSchema,
  type CancelOrderResponseBody,
  type OrderSnapshotView,
} from '@hamro-pasal/shared-types';

import { apiRequest } from './http';

export function orderPath(orderId: string): string {
  return `/api/orders/${encodeURIComponent(orderId)}`;
}

export function cancelOrderPath(orderId: string): string {
  return `${orderPath(orderId)}/cancel`;
}

/** POST /api/orders/:id/cancel answers 422 with this code once the 60 s window has closed. */
export const CANCELLATION_WINDOW_EXPIRED = 'CANCELLATION_WINDOW_EXPIRED';

/** GET /api/orders/:id: the customer's full order (state, address, items, placed/delivered times). */
export async function fetchOrder(orderId: string): Promise<OrderSnapshotView> {
  const { order } = await apiRequest({
    method: 'GET',
    path: orderPath(orderId),
    schema: orderDetailResponseSchema,
  });
  return order;
}

/**
 * POST /api/orders/:id/cancel (customer journey 8). The server enforces the 60 s window from
 * placement, restores stock and flags prepaid orders for refund. Repeating it is harmless.
 */
export function cancelOrder(orderId: string): Promise<CancelOrderResponseBody> {
  return apiRequest({
    method: 'POST',
    path: cancelOrderPath(orderId),
    schema: cancelOrderResponseSchema,
  });
}
