import {
  homePromotionsResponseSchema,
  type HomePromotionsResponseBody,
} from '@hamro-pasal/shared-types';

import { apiRequest } from './http';

export const HOME_PROMOTIONS_PATH = '/api/home/promotions';

/** GET /api/home/promotions: public, like the taxonomy, so Home shows them before sign-in. */
export function fetchHomePromotions(): Promise<HomePromotionsResponseBody> {
  return apiRequest({
    method: 'GET',
    path: HOME_PROMOTIONS_PATH,
    authenticated: false,
    schema: homePromotionsResponseSchema,
  });
}
