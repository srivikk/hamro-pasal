import {
  driverDeliverRequestSchema,
  driverDeliverResponseSchema,
  driverOrderListResponseSchema,
  type DriverDeliverResponseBody,
  type DriverOrderView,
} from '@hamro-pasal/shared-types';

import { ApiError, apiRequest } from './http';

export const DRIVER_ORDERS_PATH = '/api/driver/orders';

/** Error codes of POST /api/driver/orders/:id/deliver that the rider's screen branches on. */
export const DELIVERY_ERROR_CODES = {
  /** 401: the code does not match; `details.attempts_remaining` tries are left. */
  invalidOtp: 'INVALID_OTP',
  /** 429: too many wrong codes; `details.retry_after_seconds` until the order unlocks. */
  locked: 'DELIVERY_OTP_LOCKED',
  /** Client side: the typed code is not 4 ASCII digits (nothing was sent). */
  malformedOtp: 'INVALID_DELIVERY_CODE',
} as const;

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
export function deliverDriverOrder(
  orderId: string,
  deliveryOtp: string,
): Promise<DriverDeliverResponseBody> {
  const body = driverDeliverRequestSchema.safeParse({ delivery_otp: deliveryOtp });
  if (!body.success) {
    return Promise.reject(
      new ApiError(400, DELIVERY_ERROR_CODES.malformedOtp, 'The delivery code must be 4 digits'),
    );
  }
  return apiRequest({
    method: 'POST',
    path: driverDeliverPath(orderId),
    body: body.data,
    schema: driverDeliverResponseSchema,
  });
}
