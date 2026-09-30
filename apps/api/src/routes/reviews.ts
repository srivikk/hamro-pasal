import {
  reviewSubmitRequestSchema,
  type ReviewSubmitResponseBody,
} from '@hamro-pasal/shared-types';
import { Router } from 'express';

import { authOf } from '../http/auth';
import { parseInput } from '../http/validate';
import type { ReviewService } from '../reviews/review-service';
import { reviewView } from './views';

/** Mounted at /api/reviews behind requireAuth(CUSTOMER). */
export function reviewsRouter(reviewService: ReviewService): Router {
  const router = Router();

  /**
   * SPEC §6 / customer journey 11: the customer rates the vendor of a DELIVERED order. The review
   * is quarantined (status QUARANTINED) until the vendor rates the customer too, or 48 h pass.
   */
  router.post('/', async (req, res) => {
    const input = parseInput(reviewSubmitRequestSchema, req.body);
    const review = await reviewService.submit({
      orderId: input.order_id,
      direction: 'CUSTOMER_TO_VENDOR',
      authorUserId: authOf(req).userId,
      rating: input.rating,
      feedback: input.feedback,
    });
    const body: ReviewSubmitResponseBody = { review: reviewView(review) };
    res.status(201).json(body);
  });

  return router;
}
