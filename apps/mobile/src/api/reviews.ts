import {
  reviewSubmitRequestSchema,
  reviewSubmitResponseSchema,
  type ReviewSubmitRequest,
  type ReviewView,
} from '@hamro-pasal/shared-types';
import { z } from 'zod';

import { ApiError, apiRequest } from './http';

export const REVIEWS_PATH = '/api/reviews';

/** Server codes the review modal branches on (STATE_HANDOFF §8 error table). */
export const REVIEW_ERROR_CODES = {
  /** 409: this order already has the customer's review; details.review_id names it. */
  alreadySubmitted: 'REVIEW_ALREADY_SUBMITTED',
  /** 422: more than 48 h since delivery. */
  windowClosed: 'REVIEW_WINDOW_CLOSED',
  /** 409: the order is not DELIVERED (per the server). */
  notDelivered: 'ORDER_STATE_CONFLICT',
  /** Client-side: the input broke the request contract; nothing was sent. */
  invalid: 'INVALID_REVIEW',
} as const;

const alreadySubmittedDetailsSchema = z.object({ review_id: z.uuid() });

/** The existing review's id carried by a 409 REVIEW_ALREADY_SUBMITTED, if any. */
export function existingReviewId(error: unknown): string | null {
  if (!(error instanceof ApiError) || error.code !== REVIEW_ERROR_CODES.alreadySubmitted) {
    return null;
  }
  const details = alreadySubmittedDetailsSchema.safeParse(error.details);
  return details.success ? details.data.review_id : null;
}

/**
 * POST /api/reviews (SPEC §6): the customer's 1-5 rating of a delivered order's vendor, with
 * optional feedback (trimmed; blank becomes null). The server answers with the stored review,
 * `status: 'QUARANTINED'` until the vendor rates too or 48 h pass, `'PUBLISHED'` if the vendor
 * already had.
 */
export async function submitReview(input: ReviewSubmitRequest): Promise<ReviewView> {
  const body = reviewSubmitRequestSchema.safeParse(input);
  if (!body.success) {
    throw new ApiError(400, REVIEW_ERROR_CODES.invalid, body.error.message);
  }
  const { review } = await apiRequest({
    method: 'POST',
    path: REVIEWS_PATH,
    body: body.data,
    schema: reviewSubmitResponseSchema,
  });
  return review;
}
