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
  setOwnProductAvailability,
  replaceOwnProduct,
  setOwnProductStock,
  uploadOwnProductImages,
  type LocalPhoto,
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
/**
 * The Catalogue row's In Stock / Out of Stock switch (2026-10-21): only `in_stock`, never the
 * count and never whether customers see the product (the Super Admin's moderation).
 */
export function useSetProductInStock() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ product, inStock }: { product: VendorProductView; inStock: boolean }) =>
      setOwnProductAvailability(product.id, inStock),
    retry: false,
    onSuccess: (product) => {
      patchCachedProduct(queryClient, product);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: OWN_PRODUCTS_QUERY_KEY }),
  });
}

/** The details were saved but the photos were not: the form says so and keeps them. */
export class PhotoUploadError extends Error {
  constructor(
    readonly product: VendorProductView,
    override readonly cause: unknown,
  ) {
    super('Product saved; its photos were not uploaded');
    this.name = 'PhotoUploadError';
  }
}

/**
 * The product form's Save: POST for a new product (with its starting stock), or PUT of the
 * details and, when the count changed, PATCH …/stock; then (2026-10-21) the photos picked
 * since, as one multipart upload. Never retried automatically.
 */
export function useSaveProduct() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      current,
      draft,
      photos = [],
    }: {
      current: VendorProductView | null;
      draft: ProductDraft;
      photos?: readonly LocalPhoto[];
    }): Promise<VendorProductView> => {
      const saved = await saveDetails(current, draft);
      if (photos.length === 0) return saved;
      try {
        return await uploadOwnProductImages(saved.id, photos);
      } catch (error) {
        patchCachedProduct(queryClient, saved);
        throw new PhotoUploadError(saved, error);
      }
    },
    retry: false,
    onSuccess: (product) => {
      patchCachedProduct(queryClient, product);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: OWN_PRODUCTS_QUERY_KEY }),
  });
}

async function saveDetails(
  current: VendorProductView | null,
  draft: ProductDraft,
): Promise<VendorProductView> {
  if (current === null) return createOwnProduct(draft);
  const saved = await replaceOwnProduct(current, {
    category_id: draft.categoryId,
    name: draft.name,
    price_npr: draft.priceNpr,
  });
  if (draft.stockQuantity === saved.stock_quantity) return saved;
  return setOwnProductStock(saved.id, draft.stockQuantity);
}
