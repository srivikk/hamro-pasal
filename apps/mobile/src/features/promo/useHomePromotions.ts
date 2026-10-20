import type { HomePromotionsResponseBody } from '@hamro-pasal/shared-types';
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';

import { fetchHomePromotions } from '../../api/promotions';
import { retryTransientFailures } from '../../api/query-client';
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
 * Only what the server sent, in every build (2026-10-20: a development build no longer shows
 * sample banners). The server sends only the promotions the Super Admin has switched on and that
 * are inside their dates. No banner: the carousel is not drawn; no offer: neither is the Featured
 * Offers row (nor its heading). Until the answer is in, or if it fails, both rows stay away.
 */
export function useHomePromotions(): HomePromotions {
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
  return live;
}
