import type { VendorAnalyticsSummary } from '@hamro-pasal/shared-types';
import { Router } from 'express';

import type { VendorAnalyticsService } from '../analytics/vendor-analytics-service';
import { authOf } from '../http/auth';

/**
 * Mounted at /api/vendor/analytics behind requireAuth(VENDOR) (Phase 35). Any vendor status may
 * read it: a suspended shop still has a history. The shop is always the caller's own.
 */
export function vendorAnalyticsRouter(analytics: VendorAnalyticsService): Router {
  const router = Router();
  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  router.get('/summary', async (req, res) => {
    const body: VendorAnalyticsSummary = await analytics.summary(authOf(req).userId);
    res.json(body);
  });

  return router;
}
