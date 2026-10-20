import { useQuery } from '@tanstack/react-query';

import { fetchCategories } from '../../api/catalog';
import { retryTransientFailures } from '../../api/query-client';

export const CATEGORIES_QUERY_KEY = ['categories'] as const;

/** The taxonomy changes rarely (a Super Admin edits it), so it is served from cache for a while. */
export const CATEGORIES_STALE_MS = 5 * 60 * 1000;

/**
 * GET /api/categories (public). Cached under one key; invalidated when the product list reports
 * that a chosen category is gone (404 CATEGORY_NOT_FOUND).
 *
 * Kept current without a restart (a Super Admin may hide a category at any time): refetched every
 * time the app returns to the foreground (`refetchOnWindowFocus: 'always'`, see app-focus.ts),
 * when Home comes back into view, and by Home's pull to refresh.
 */
export function useCategoriesQuery() {
  return useQuery({
    queryKey: CATEGORIES_QUERY_KEY,
    queryFn: fetchCategories,
    staleTime: CATEGORIES_STALE_MS,
    refetchOnWindowFocus: 'always',
    retry: retryTransientFailures,
  });
}
