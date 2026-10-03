import { deliveryOtpRequestSchema, type DeliveryOtpRequest } from '@hamro-pasal/shared-types';

import { ApiError } from './http';

/**
 * Error codes of the doorstep handoff (POST /api/deliveries/:id/complete and
 * /api/vendors/orders/:id/deliver) that the screens branch on.
 */
export const DELIVERY_ERROR_CODES = {
  /** 401: the code does not match; `details.attempts_remaining` tries are left. */
  invalidOtp: 'INVALID_OTP',
  /** 429: too many wrong codes; `details.retry_after_seconds` until the order unlocks. */
  locked: 'DELIVERY_OTP_LOCKED',
  /** 409 (vendor only): a fleet order; the platform rider hands it over. */
  wrongFulfillment: 'WRONG_FULFILLMENT_MODE',
  /** Client side: the typed code is not 4 ASCII digits (nothing was sent). */
  malformedOtp: 'INVALID_DELIVERY_CODE',
} as const;

/**
 * The request body for a handoff, validated before anything is sent: a malformed code is refused
 * on the device and never counts as one of the five attempts.
 */
export function deliveryOtpBody(deliveryOtp: string): DeliveryOtpRequest {
  const body = deliveryOtpRequestSchema.safeParse({ delivery_otp: deliveryOtp });
  if (!body.success) {
    throw new ApiError(
      400,
      DELIVERY_ERROR_CODES.malformedOtp,
      'The delivery code must be 4 digits',
    );
  }
  return body.data;
}
