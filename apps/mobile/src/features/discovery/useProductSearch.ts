import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';

import { CATEGORY_NOT_FOUND, fetchProducts, type ProductListFilter } from '../../api/catalog';
import { ApiError } from '../../api/http';
import { retryTransientFailures } from '../../api/query-client';
import { useDebouncedValue } from '../../lib/useDebouncedValue';
import { SEARCH_DEBOUNCE_MS, toSearchTerm } from './discovery-rules';
import { CATEGORIES_QUERY_KEY } from './useCategoriesQuery';

/** Prefix of every product-list key: invalidate it when stock is known to have changed. */
export const PRODUCTS_QUERY_KEY = ['products'] as const;

export function productsQueryKey(filter: ProductListFilter) {
  return [...PRODUCTS_QUERY_KEY, filter.categoryId, filter.search] as const;
}

/**
 * The product list for the search field and the chosen category (GET /api/products, paged).
 *
 * The typed text is debounced by SEARCH_DEBOUNCE_MS: the request is keyed on the text as it was
 * when typing last paused, so a burst of keystrokes asks the server once. A category change is
 * not debounced (one tap, one request). Nothing is asked while neither filter is set.
 */
export function useProductSearch(input: string, categoryId: string | null) {
  const queryClient = useQueryClient();
  const term = toSearchTerm(input);
  const search = useDebouncedValue(term, SEARCH_DEBOUNCE_MS);
  const filter: ProductListFilter = { categoryId, search };
  /** The field or a category is in use, so products (not shops) are being browsed. */
  const active = term !== null || categoryId !== null;

  const query = useInfiniteQuery({
    queryKey: productsQueryKey(filter),
    queryFn: async ({ pageParam }) => {
      try {
        return await fetchProducts(filter, pageParam);
      } catch (error) {
        // The category was hidden or deleted since the pills were loaded: refresh them.
        if (error instanceof ApiError && error.code === CATEGORY_NOT_FOUND) {
          void queryClient.invalidateQueries({ queryKey: CATEGORIES_QUERY_KEY });
        }
        throw error;
      }
    },
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.next_cursor,
    enabled: search !== null || categoryId !== null,
    // Stock moves with every order: always re-ask when the list is shown again.
    staleTime: 0,
    retry: retryTransientFailures,
  });

  return {
    active,
    /** The search that was sent (or will be, once typing rests). */
    search,
    /** The field changed less than SEARCH_DEBOUNCE_MS ago: the list shown is for older text. */
    isDebouncing: term !== search,
    query,
  };
}

export type ProductSearch = ReturnType<typeof useProductSearch>;
