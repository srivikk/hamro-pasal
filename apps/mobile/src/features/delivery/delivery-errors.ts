import type { useTranslation } from 'react-i18next';
import { z } from 'zod';

import { DELIVERY_ERROR_CODES } from '../../api/delivery';
import { ApiError } from '../../api/http';
import { lockoutMinutes } from './delivery-otp-input';

const attemptsDetailsSchema = z.object({ attempts_remaining: z.number().int().nonnegative() });
const lockoutDetailsSchema = z.object({ retry_after_seconds: z.number().int().positive() });

/**
 * The order cannot be handed over from this screen any more (delivered meanwhile, another rider's,
 * a fleet order on the vendor's screen): drop it from the list rather than let the user retry.
 */
export function isStaleDeliveryError(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    (error.code === 'ORDER_STATE_CONFLICT' ||
      error.code === 'ORDER_NOT_FOUND' ||
      error.code === DELIVERY_ERROR_CODES.wrongFulfillment)
  );
}

type Translate = ReturnType<typeof useTranslation>['t'];

/** The toast for a failed handoff, for the rider's and the vendor's screens alike. */
export function deliveryErrorMessage(error: unknown, t: Translate): string {
  if (isStaleDeliveryError(error)) return t('delivery.noLongerDeliverable');
  if (!(error instanceof ApiError)) return t('delivery.failed');
  switch (error.code) {
    case DELIVERY_ERROR_CODES.invalidOtp: {
      const details = attemptsDetailsSchema.safeParse(error.details);
      return details.success
        ? t('delivery.wrongCode', { count: details.data.attempts_remaining })
        : t('delivery.wrongCodeNoCount');
    }
    case DELIVERY_ERROR_CODES.locked: {
      const details = lockoutDetailsSchema.safeParse(error.details);
      return t('delivery.locked', {
        minutes: lockoutMinutes(details.success ? details.data.retry_after_seconds : 60),
      });
    }
    case DELIVERY_ERROR_CODES.malformedOtp:
      return t('delivery.incompleteCode');
    default:
      return t('delivery.failed');
  }
}
