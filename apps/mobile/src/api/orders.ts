import { lockStatusResponseSchema, type OrderView } from '@hamro-pasal/shared-types';

import { apiRequest } from './http';
import { LOCK_STATUS_PATH } from './queries';

/**
 * The customer's current view of an order. The backend has no order-tracking endpoint yet
 * (STATE_HANDOFF §8), but GET /api/cart/lock-status returns the owner's OrderView in every state
 * (lock RELEASED once the order has left checkout), so it serves as the order read until then.
 */
export async function fetchOrder(orderId: string): Promise<OrderView> {
  const { order } = await apiRequest({
    method: 'GET',
    path: LOCK_STATUS_PATH,
    query: { order_id: orderId },
    schema: lockStatusResponseSchema,
  });
  return order;
}
