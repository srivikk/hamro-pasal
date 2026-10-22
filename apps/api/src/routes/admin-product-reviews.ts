import {
  adminProductReviewListQuerySchema,
  adminProductReviewModerationRequestSchema,
  idParamSchema,
  type AdminProductReviewListResponseBody,
  type AdminProductReviewResponseBody,
} from '@hamro-pasal/shared-types';
import { Router } from 'express';

import { authOf } from '../http/auth';
import { auditContextOf } from '../http/request-context';
import { parseInput } from '../http/validate';
import type { ProductReviewModerationService } from '../reviews/product-review-moderation-service';

/**
 * Mounted at /api/admin/product-reviews behind SUPER_ADMIN auth (2026-10-22, Task 6):
 *   GET   /       every product review, newest first (?status=VISIBLE|HIDDEN&cursor=&limit=)
 *   PATCH /:id    { hidden: true, reason } or { hidden: false }; audited, also on repeat (no-op)
 */
export function adminProductReviewsRouter(moderation: ProductReviewModerationService): Router {
  const router = Router();
  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  router.get('/', async (req, res) => {
    const query = parseInput(adminProductReviewListQuerySchema, { ...req.query });
    const page = await moderation.list(query);
    const body: AdminProductReviewListResponseBody = {
      reviews: [...page.reviews],
      next_cursor: page.nextCursor,
    };
    res.json(body);
  });

  router.patch('/:id', async (req, res) => {
    const { id } = parseInput(idParamSchema, { ...req.params });
    const input = parseInput(adminProductReviewModerationRequestSchema, req.body);
    const body: AdminProductReviewResponseBody = {
      review: await moderation.moderate(authOf(req).userId, id, input, auditContextOf(req, res)),
    };
    res.json(body);
  });

  return router;
}
