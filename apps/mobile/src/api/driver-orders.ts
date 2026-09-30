import {
  deliveryConfirmedResponseSchema,
  driverOrderListResponseSchema,
  type DeliveryConfirmedResponseBody,
  type DriverOrderView,
} from '@hamro-pasal/shared-types';

import { deliveryOtpBody } from './delivery';
import { apiRequest } from './http';

export const DRIVER_ORDERS_PATH = '/api/driver/orders';

export function driverDeliverPath(orderId: string): string {
  return `${DRIVER_ORDERS_PATH}/${encodeURIComponent(orderId)}/deliver`;
}

/** GET /api/driver/orders: fleet orders out for delivery that this rider carries or may claim. */
export async function fetchDriverOrders(): Promise<DriverOrderView[]> {
  const { orders } = await apiRequest({
    method: 'GET',
    path: DRIVER_ORDERS_PATH,
    schema: driverOrderListResponseSchema,
  });
  return orders;
}

/**
 * POST /api/driver/orders/:id/deliver with the customer's 4-digit code (driver flow step 5). The
 * code is validated first; a malformed one is refused here and never counts as an attempt.
 */
export async function deliverDriverOrder(
  orderId: string,
  deliveryOtp: string,
): Promise<DeliveryConfirmedResponseBody> {
  const body = deliveryOtpBody(deliveryOtp);
  return apiRequest({
    method: 'POST',
    path: driverDeliverPath(orderId),
    body,
    schema: deliveryConfirmedResponseSchema,
  });
}
