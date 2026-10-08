import type { HomePromotionsResponseBody, HomePromotionView } from '@hamro-pasal/shared-types';
import { Router } from 'express';

import type { PromotionRow, PromotionService } from '../marketing/promotion-service';

export function homePromotionView(promotion: PromotionRow): HomePromotionView {
  return {
    id: promotion.id,
    placement: promotion.placement,
    image_url: promotion.image_url,
    title: promotion.title,
    subtitle: promotion.subtitle,
    target_type: promotion.target_type,
    target_value: promotion.target_value,
    is_sponsored: promotion.is_sponsored,
  };
}

/**
 * Mounted at /api/home, public (no token): what the customer app's Home shows before sign-in,
 * like the taxonomy and the feed. A promotion navigates or filters; it never changes a price.
 */
export function homeRouter(promotions: PromotionService): Router {
  const router = Router();

  router.get('/promotions', async (_req, res) => {
    const views = (await promotions.listPublic()).map(homePromotionView);
    const body: HomePromotionsResponseBody = {
      banners: views.filter((view) => view.placement === 'CAROUSEL'),
      offers: views.filter((view) => view.placement === 'FEATURED'),
    };
    res.setHeader('Cache-Control', 'public, max-age=60');
    res.json(body);
  });

  return router;
}
