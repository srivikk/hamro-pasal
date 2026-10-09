import {
  vendorAnalyticsSummarySchema,
  type VendorAnalyticsSummary,
} from '@hamro-pasal/shared-types';

import { apiRequest } from './http';

export const VENDOR_ANALYTICS_PATH = '/api/vendor/analytics/summary';

/**
 * GET /api/vendor/analytics/summary: today, the top item, the ad return and seven days of sales
 * for the signed-in vendor's own shop. Every figure is computed by the server, in Nepal Time.
 */
export function fetchVendorAnalytics(): Promise<VendorAnalyticsSummary> {
  return apiRequest({
    method: 'GET',
    path: VENDOR_ANALYTICS_PATH,
    schema: vendorAnalyticsSummarySchema,
  });
}
