import {
  idParamSchema,
  productReviewListQuerySchema,
  productReviewRequestSchema,
  type ProductReviewListResponseBody,
  type ProductReviewResponseBody,
} from '@hamro-pasal/shared-types';
import { Router, type RequestHandler } from 'express';

import { authOf } from '../http/auth';
import { parseInput } from '../http/validate';
import type { ProductReviewService } from '../reviews/product-review-service';

/**
 * Mounted at /api/products (2026-10-21, Task 5) ahead of the public product list:
 *   GET  /:id/reviews  public; a signed-in customer also learns whether they may review it
 *   POST /:id/reviews  CUSTOMER; a verified purchase only (403 NOT_A_VERIFIED_PURCHASE)
 */
export function productReviewsRouter(
  reviews: ProductReviewService,
  auth: { readonly optional: RequestHandler; readonly customer: RequestHandler },
): Router {
  const router = Router();

  router.get('/:id/reviews', auth.optional, async (req, res) => {
    const { id } = parseInput(idParamSchema, { ...req.params });
    const { cursor } = parseInput(productReviewListQuerySchema, { ...req.query });
    const viewerId = req.auth?.role === 'CUSTOMER' ? req.auth.userId : null;
    const page = await reviews.list(id, cursor, viewerId);
    const body: ProductReviewListResponseBody = {
      summary: page.summary,
      reviews: [...page.reviews],
      next_cursor: page.nextCursor,
      viewer:
        page.viewer === null
          ? null
          : { can_review: page.viewer.canReview, own_review: page.viewer.ownReview },
    };
    // Personal when signed in; public otherwise.
    res.set('Cache-Control', viewerId === null ? 'public, max-age=60' : 'private, no-store');
    res.json(body);
  });

  router.post('/:id/reviews', auth.customer, async (req, res) => {
    const { id } = parseInput(idParamSchema, { ...req.params });
    const input = parseInput(productReviewRequestSchema, req.body);
    const body: ProductReviewResponseBody = {
      review: await reviews.upsert(authOf(req).userId, id, input),
    };
    res.status(201).json(body);
  });

  return router;
}
