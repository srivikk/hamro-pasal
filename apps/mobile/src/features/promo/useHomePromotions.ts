import type { FeedResponse, HomePromotionsResponseBody } from '@hamro-pasal/shared-types';
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';

import { fetchHomePromotions } from '../../api/promotions';
import { retryTransientFailures } from '../../api/query-client';
import { homePromotions } from './mock-promotions';
import { NO_PROMOTIONS, type HomePromotions } from './promo-model';

export const homePromotionsQueryKey = ['home', 'promotions'] as const;

/**
 * The server's answer as the Home rows take it. A banner is its artwork and a tile its text; the
 * server guarantees both, and a row that lacks its own is left out rather than drawn empty.
 */
export function toHomePromotions(body: HomePromotionsResponseBody): HomePromotions {
  return {
    banners: body.banners.flatMap((banner) =>
      banner.image_url === null
        ? []
        : [{ ...banner, placement: 'CAROUSEL' as const, image_url: banner.image_url }],
    ),
    offers: body.offers.flatMap((offer) =>
      offer.title === null
        ? []
        : [{ ...offer, placement: 'FEATURED' as const, title: offer.title }],
    ),
  };
}

/**
 * The Home banners and Featured Offers: GET /api/home/promotions (the Super Admin's promotions
 * that are running now, stale targets already dropped by the server).
 *
 * While the server has none (or cannot be reached), a development build still shows the sample
 * promotions of `mock-promotions.ts` so the rows can be worked on; a production build shows only
 * what the server sent, and nothing when it sent nothing.
 */
export function useHomePromotions(feed: FeedResponse | undefined): HomePromotions {
  const query = useQuery({
    queryKey: homePromotionsQueryKey,
    queryFn: fetchHomePromotions,
    staleTime: 60_000,
    retry: retryTransientFailures,
  });
  const live = useMemo(
    () => (query.data === undefined ? NO_PROMOTIONS : toHomePromotions(query.data)),
    [query.data],
  );
  return live.banners.length + live.offers.length > 0 ? live : homePromotions(feed);
}
