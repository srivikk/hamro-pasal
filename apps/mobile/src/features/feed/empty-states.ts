import type { FeedResponse } from '@hamro-pasal/shared-types';

/*
 * Which empty state the Home screen shows (decided 2026-10-20). An empty list caused by the
 * platform having no shops yet must not read like a problem with the customer's location: that is
 * an inventory shortage, and the app says so in a welcoming way.
 */

/**
 * The feed lists every LIVE shop: those that deliver to the customer, then all the others
 * (Explore Further). Both sections empty means no shop is live anywhere: ONBOARDING. A feed with
 * shops that merely do not deliver here keeps the location wording (NONE_NEARBY). With the
 * delivery Emergency Stop on (`delivery_available: false`) nothing is listed for that reason
 * instead, so the onboarding wording would be wrong: it stays NONE_NEARBY.
 */
export function feedEmptyState(
  feed: Pick<FeedResponse, 'serviceable' | 'explore_further' | 'delivery_available'>,
): 'ONBOARDING' | 'NONE_NEARBY' | null {
  if (feed.serviceable.length > 0) return null;
  if (feed.explore_further.length === 0 && feed.delivery_available) return 'ONBOARDING';
  return 'NONE_NEARBY';
}

/**
 * A chosen category that leaves no shop. `categoryVendorIds` are the shops anywhere in Nepal that
 * sell something in it (from the public product list): none at all is ONBOARDING; some that are
 * not in the customer's list is NONE_NEARBY.
 */
export function categoryEmptyState(
  categoryVendorIds: readonly string[],
): 'ONBOARDING' | 'NONE_NEARBY' {
  return categoryVendorIds.length === 0 ? 'ONBOARDING' : 'NONE_NEARBY';
}
