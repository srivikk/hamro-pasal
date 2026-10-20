import type { VendorProductListResponseBody, VendorProductView } from '@hamro-pasal/shared-types';
import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
  type InfiniteData,
  type QueryClient,
} from '@tanstack/react-query';

import { retryTransientFailures } from '../../api/query-client';
import {
  createOwnProduct,
  fetchOwnProducts,
  hideOwnProduct,
  replaceOwnProduct,
  setOwnProductStock,
  type ProductDraft,
} from '../../api/vendor-products';

export const OWN_PRODUCTS_QUERY_KEY = ['vendor', 'products'] as const;

type ProductPages = InfiniteData<VendorProductListResponseBody, string | null>;

/** The shop's own products from GET /api/vendor/products, 50 at a time, by name. */
export function useOwnProductsQuery() {
  return useInfiniteQuery({
    queryKey: OWN_PRODUCTS_QUERY_KEY,
    queryFn: ({ pageParam }) => fetchOwnProducts(pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next_cursor,
    staleTime: 0,
    retry: retryTransientFailures,
  });
}

/** Every product loaded so far, in the server's order. */
export function loadedProducts(
  data: InfiniteData<VendorProductListResponseBody> | undefined,
): VendorProductView[] {
  return data?.pages.flatMap((page) => page.products) ?? [];
}

/** Writes the server's answer for one product into the cached pages, where it already is. */
function patchCachedProduct(queryClient: QueryClient, product: VendorProductView): void {
  queryClient.setQueryData<ProductPages>(OWN_PRODUCTS_QUERY_KEY, (data) =>
    data === undefined
      ? data
      : {
          ...data,
          pages: data.pages.map((page) => ({
            ...page,
            products: page.products.map((each) => (each.id === product.id ? product : each)),
          })),
        },
  );
}

/**
 * The row's switch: shown to customers (PUT with `is_active: true`) or hidden (DELETE, a soft
 * delete). Never retried automatically. The answer is written into the list at once, then the
 * list is refetched.
 */
export function useSetProductListed() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ product, listed }: { product: VendorProductView; listed: boolean }) => {
      if (listed) return replaceOwnProduct(product, { is_active: true });
      await hideOwnProduct(product.id);
      return { ...product, is_active: false };
    },
    retry: false,
    onSuccess: (product) => {
      patchCachedProduct(queryClient, product);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: OWN_PRODUCTS_QUERY_KEY }),
  });
}

/**
 * The product form's Save: POST for a new product (with its starting stock), or PUT of the
 * details and, when the count changed, PATCH …/stock. Never retried automatically.
 */
export function useSaveProduct() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      current,
      draft,
    }: {
      current: VendorProductView | null;
      draft: ProductDraft;
    }): Promise<VendorProductView> => {
      if (current === null) return createOwnProduct(draft);
      const saved = await replaceOwnProduct(current, {
        category_id: draft.categoryId,
        name: draft.name,
        price_npr: draft.priceNpr,
      });
      if (draft.stockQuantity === saved.stock_quantity) return saved;
      return setOwnProductStock(saved.id, draft.stockQuantity);
    },
    retry: false,
    onSuccess: (product) => {
      patchCachedProduct(queryClient, product);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: OWN_PRODUCTS_QUERY_KEY }),
  });
}
