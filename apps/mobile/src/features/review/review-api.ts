import { reviewSchema } from '@hamro-pasal/shared-types';
import { z } from 'zod';

/** A customer's review of an order's vendor (direction CUSTOMER_TO_VENDOR). */
export const MAX_REVIEW_COMMENT_LENGTH = 500;

/**
 * Review input, reusing the shared-types review rules: rating is an integer 1-5, comment is
 * trimmed and non-empty or null. A blank comment is sent as null, never as "".
 */
export const reviewInputSchema = z.object({
  order_id: z.string().min(1),
  rating: reviewSchema.shape.rating,
  comment: z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? null : value),
    reviewSchema.shape.comment.pipe(z.string().max(MAX_REVIEW_COMMENT_LENGTH).nullable()),
  ),
});
export type ReviewInput = z.infer<typeof reviewInputSchema>;

export interface SubmittedReview {
  review_id: string;
  order_id: string;
  /** Always false on submission: double-blind quarantine (SPEC §6). */
  is_published: false;
}

/*
 * MOCK review API. No review endpoint exists yet (STATE_HANDOFF §8). The server will store the
 * review with is_published = false and publish it when the vendor also rates, or 48 h elapse.
 */
let reviewCounter = 0;

export async function submitReview(
  input: ReviewInput,
  { latencyMs = 400 }: { latencyMs?: number } = {},
): Promise<SubmittedReview> {
  const review = reviewInputSchema.parse(input);
  await new Promise((resolve) => setTimeout(resolve, latencyMs));
  reviewCounter += 1;
  return {
    review_id: `mock-review-${String(reviewCounter)}`,
    order_id: review.order_id,
    is_published: false,
  };
}
