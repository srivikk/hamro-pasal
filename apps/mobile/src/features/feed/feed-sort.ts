import type { FeedEntry, FeedResponse } from '@hamro-pasal/shared-types';

import {
  estimatedDeliveryMinutes,
  hasOfferTag,
  type ExtrasSubject,
  type VendorExtras,
} from '../promo/promo-model';

/** The orders the "Sort & filter" sheet offers, in the order it lists them. */
export const FEED_SORTS = [
  'relevance',
  'delivery_time',
  'rating',
  'cost_low_to_high',
  'cost_high_to_low',
] as const;

export type FeedSort = (typeof FEED_SORTS)[number];

/** Relevance is the server's own order (nearest first). */
export const DEFAULT_FEED_SORT: FeedSort = 'relevance';

/** Smaller sorts first; null (the value is unknown for this shop) always sorts last. */
type SortKey = (entry: FeedEntry, extras: VendorExtras) => number | null;

const SORT_KEYS: Record<Exclude<FeedSort, 'relevance'>, SortKey> = {
  delivery_time: (entry, extras) =>
    estimatedDeliveryMinutes(extras.prep_minutes, entry.distance_km),
  rating: (_entry, extras) => (extras.rating_average === null ? null : -extras.rating_average),
  cost_low_to_high: (_entry, extras) => extras.average_cost_npr,
  cost_high_to_low: (_entry, extras) =>
    extras.average_cost_npr === null ? null : -extras.average_cost_npr,
};

function sortEntries(
  entries: readonly FeedEntry[],
  key: SortKey,
  extrasOf: (vendor: ExtrasSubject) => VendorExtras,
): FeedEntry[] {
  return entries
    .map((entry, position) => ({ entry, position, value: key(entry, extrasOf(entry.vendor)) }))
    .sort((a, b) => {
      if (a.value === null || b.value === null) {
        if (a.value === b.value) return a.position - b.position;
        return a.value === null ? 1 : -1;
      }
      // Equal values keep the server's order (nearest first).
      return a.value - b.value || a.position - b.position;
    })
    .map(({ entry }) => entry);
}

/**
 * The feed in the chosen order. Each section is sorted by itself, so shops that deliver here
 * always stay above "Explore Further" (SPEC customer flow step 3).
 */
export function sortFeed(
  feed: FeedResponse,
  sort: FeedSort,
  extrasOf: (vendor: ExtrasSubject) => VendorExtras,
): FeedResponse {
  if (sort === 'relevance') return feed;
  const key = SORT_KEYS[sort];
  return {
    ...feed,
    // The (at most two) sponsored listings paid for the top: a sort reorders everyone else.
    serviceable: [
      ...feed.serviceable.filter((entry) => entry.is_sponsored),
      ...sortEntries(
        feed.serviceable.filter((entry) => !entry.is_sponsored),
        key,
        extrasOf,
      ),
    ],
    explore_further: sortEntries(feed.explore_further, key, extrasOf),
  };
}

/**
 * The ids of the shops (of both sections) that carry an offer label: what a DISCOUNT_TAG
 * promotion filters the feed to. The label only selects shops; it changes no price.
 */
export function vendorIdsWithOfferTag(
  feed: FeedResponse,
  tag: string,
  extrasOf: (vendor: ExtrasSubject) => VendorExtras,
): string[] {
  return [...feed.serviceable, ...feed.explore_further]
    .filter((entry) => hasOfferTag(extrasOf(entry.vendor), tag))
    .map((entry) => entry.vendor.id);
}
