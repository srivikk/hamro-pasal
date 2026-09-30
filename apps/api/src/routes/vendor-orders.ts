import {
  idParamSchema,
  vendorReviewSubmitRequestSchema,
  type ReviewSubmitResponseBody,
} from '@hamro-pasal/shared-types';
import { Router } from 'express';

import { authOf } from '../http/auth';
import { parseInput } from '../http/validate';
import type { ReviewService } from '../reviews/review-service';
import { reviewView } from './views';

/** Mounted at /api/vendors/orders behind requireAuth(VENDOR): the vendor's side of an order. */
export function vendorOrdersRouter(reviewService: ReviewService): Router {
  const router = Router();

  /**
   * SPEC §6: the vendor rates the customer of one of its DELIVERED orders. The same quarantine
   * transaction as the customer's review: if the customer has already reviewed, both reviews are
   * published now; otherwise this one stays QUARANTINED until they do or 48 h pass.
   */
  router.post('/:id/reviews', async (req, res) => {
    const { id } = parseInput(idParamSchema, { ...req.params });
    const input = parseInput(vendorReviewSubmitRequestSchema, req.body);
    const review = await reviewService.submit({
      orderId: id,
      direction: 'VENDOR_TO_CUSTOMER',
      authorUserId: authOf(req).userId,
      rating: input.rating,
      feedback: input.feedback,
    });
    const body: ReviewSubmitResponseBody = { review: reviewView(review) };
    res.status(201).json(body);
  });

  return router;
}
