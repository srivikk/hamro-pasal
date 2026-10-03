import {
  deliveryConfirmedResponseSchema,
  deliveryListResponseSchema,
  deliveryResponseSchema,
  type DeliveryConfirmedResponseBody,
  type DeliveryView,
} from '@hamro-pasal/shared-types';

import { deliveryOtpBody } from './delivery';
import { apiRequest } from './http';

export const DELIVERIES_PATH = '/api/deliveries';

/** The two steps a rider takes before the door: accept an open gig, then pick the parcel up. */
export type DeliveryStep = 'accept' | 'pickup';

export function deliveryPath(deliveryId: string, action: DeliveryStep | 'complete'): string {
  return `${DELIVERIES_PATH}/${encodeURIComponent(deliveryId)}/${action}`;
}

/** Error codes of the rider's delivery routes that the screens branch on. */
export const DELIVERY_ROUTE_ERROR_CODES = {
  /** 404: unknown, or another rider's. */
  notFound: 'DELIVERY_NOT_FOUND',
  /** 409: another rider accepted the gig first. */
  alreadyAssigned: 'DELIVERY_ALREADY_ASSIGNED',
  /** 409: the delivery is not at the step this action starts from. */
  stateConflict: 'DELIVERY_STATE_CONFLICT',
} as const;

/** GET /api/deliveries: open gigs and this rider's own deliveries still on the road. */
export async function fetchDeliveries(): Promise<DeliveryView[]> {
  const { deliveries } = await apiRequest({
    method: 'GET',
    path: DELIVERIES_PATH,
    schema: deliveryListResponseSchema,
  });
  return deliveries;
}

/** POST /api/deliveries/:id/accept or …/pickup (driver flow steps 1 and 2). No body. */
export async function advanceDelivery(
  deliveryId: string,
  step: DeliveryStep,
): Promise<DeliveryView> {
  const { delivery } = await apiRequest({
    method: 'POST',
    path: deliveryPath(deliveryId, step),
    schema: deliveryResponseSchema,
  });
  return delivery;
}

/**
 * POST /api/deliveries/:id/complete with the customer's 4-digit code (driver flow step 5). The
 * code is validated first; a malformed one is refused here and never counts as an attempt.
 */
export async function completeDelivery(
  deliveryId: string,
  deliveryOtp: string,
): Promise<DeliveryConfirmedResponseBody> {
  const body = deliveryOtpBody(deliveryOtp);
  return apiRequest({
    method: 'POST',
    path: deliveryPath(deliveryId, 'complete'),
    body,
    schema: deliveryConfirmedResponseSchema,
  });
}
