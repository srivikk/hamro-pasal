import type { FeedResponse } from '@hamro-pasal/shared-types';
import { useQuery } from '@tanstack/react-query';

import { scanProducts } from '../../api/catalog';
import { retryTransientFailures } from '../../api/query-client';

export function categoryShopsQueryKey(categoryId: string) {
  return ['category-shops', categoryId] as const;
}

/** The ids of the shops that sell at least one product in a category (or its subcategories). */
export async function fetchCategoryVendorIds(categoryId: string): Promise<string[]> {
  const products = await scanProducts({ categoryId });
  return [...new Set(products.map((product) => product.vendor.id))];
}

/**
 * Which shops carry the chosen category. Derived on the device from the public product list
 * (`GET /api/products?category_id=`), because the vendor feed carries no categories yet. Disabled
 * until a category is chosen; cached per category for a minute.
 */
export function useCategoryVendorIds(categoryId: string | null) {
  return useQuery({
    queryKey: categoryShopsQueryKey(categoryId ?? ''),
    queryFn: () => fetchCategoryVendorIds(categoryId ?? ''),
    enabled: categoryId !== null,
    staleTime: 60_000,
    retry: retryTransientFailures,
  });
}

/** The feed with only the given shops, in both sections; the feed itself when there is no filter. */
export function filterFeedByVendors(
  feed: FeedResponse,
  vendorIds: readonly string[] | null,
): FeedResponse {
  if (vendorIds === null) return feed;
  const keep = new Set(vendorIds);
  return {
    ...feed,
    serviceable: feed.serviceable.filter((entry) => keep.has(entry.vendor.id)),
    explore_further: feed.explore_further.filter((entry) => keep.has(entry.vendor.id)),
  };
}
