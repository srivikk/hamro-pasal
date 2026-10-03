import type { AdminProductListResponseBody, AdminProductView } from '@hamro-pasal/shared-types';
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
} from '@tanstack/react-query';
import { useState } from 'react';

import { ApiError } from '../../api/client';
import { useAdminApi } from '../../app-context';
import { formatNpr } from '../../lib/format';
import {
  activeToggle,
  productVisibility,
  replaceProduct,
  stockLabel,
  toggleErrorMessage,
} from './product-rules';

type ProductPages = InfiniteData<AdminProductListResponseBody, string | null>;

const productsKey = (vendorId: string) => ['admin', 'products', vendorId] as const;

/**
 * Phase 17 products overview: every vendor's products (or one vendor's), read-only except for the
 * active toggle, which hides a product from customers and from checkout.
 */
export function ProductScreen() {
  const api = useAdminApi();
  const queryClient = useQueryClient();
  // '' = all vendors.
  const [vendorId, setVendorId] = useState('');
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});

  // The same cache entry as the Vendors tab.
  const vendors = useQuery({ queryKey: ['admin', 'vendors'], queryFn: () => api.listVendors() });

  const query = useInfiniteQuery({
    queryKey: productsKey(vendorId),
    queryFn: ({ pageParam }) =>
      api.listProducts({
        vendorId: vendorId === '' ? undefined : vendorId,
        cursor: pageParam ?? undefined,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next_cursor,
  });

  const toggle = useMutation({
    mutationFn: ({ id, next }: { readonly id: string; readonly next: boolean }) =>
      api.setProductActive(id, next),
    onMutate: ({ id }) => {
      setErrors(({ [id]: _cleared, ...rest }) => rest);
    },
    onSuccess: ({ product }) => {
      // Show the new state at once, in place: refetching every loaded page is not needed.
      queryClient.setQueryData<ProductPages>(productsKey(vendorId), (current) =>
        current === undefined
          ? current
          : { ...current, pages: replaceProduct(current.pages, product) },
      );
    },
    onError: (error, { id }) => {
      setErrors((current) => ({ ...current, [id]: toggleErrorMessage(error) }));
      void queryClient.invalidateQueries({ queryKey: productsKey(vendorId) });
    },
  });

  const products = query.data?.pages.flatMap((page) => page.products) ?? [];

  return (
    <section>
      <div className="section-head">
        <div>
          <h2>Products</h2>
          <p className="muted">
            Every vendor's catalogue with its stock. Vendors manage their own products; hiding one
            here removes it from customers' lists and from checkout until it is shown again.
          </p>
        </div>
        <button
          type="button"
          className="button"
          disabled={query.isFetching}
          onClick={() => void query.refetch()}
        >
          {query.isFetching ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      <select
        className="search"
        aria-label="Vendor"
        value={vendorId}
        onChange={(event) => {
          setVendorId(event.target.value);
        }}
      >
        <option value="">All vendors</option>
        {(vendors.data?.vendors ?? []).map((vendor) => (
          <option key={vendor.id} value={vendor.id}>
            {vendor.business_name} ({vendor.status})
          </option>
        ))}
      </select>

      {query.isPending ? (
        <p className="muted">Loading…</p>
      ) : query.isError ? (
        <p className="error" role="alert">
          {query.error instanceof ApiError && query.error.code === 'NETWORK_ERROR'
            ? 'The API cannot be reached.'
            : 'The products could not be loaded.'}{' '}
          <button type="button" className="link" onClick={() => void query.refetch()}>
            Try again
          </button>
        </p>
      ) : products.length === 0 ? (
        <p className="empty">
          {vendorId === '' ? 'No vendor has added a product yet.' : 'This vendor has no products.'}
        </p>
      ) : (
        <>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Product</th>
                  <th scope="col">Vendor</th>
                  <th scope="col" className="num">
                    Price
                  </th>
                  <th scope="col" className="num">
                    Stock
                  </th>
                  <th scope="col">Customers</th>
                </tr>
              </thead>
              <tbody>
                {products.map((product) => (
                  <ProductRow
                    key={product.id}
                    product={product}
                    saving={toggle.isPending && toggle.variables.id === product.id}
                    error={errors[product.id] ?? null}
                    onToggle={(next) => {
                      toggle.mutate({ id: product.id, next });
                    }}
                  />
                ))}
              </tbody>
            </table>
          </div>
          {query.hasNextPage && (
            <button
              type="button"
              className="button load-more"
              disabled={query.isFetchingNextPage}
              onClick={() => void query.fetchNextPage()}
            >
              {query.isFetchingNextPage ? 'Loading…' : 'Load more'}
            </button>
          )}
        </>
      )}
    </section>
  );
}

function ProductRow({
  product,
  saving,
  error,
  onToggle,
}: {
  readonly product: AdminProductView;
  readonly saving: boolean;
  readonly error: string | null;
  readonly onToggle: (next: boolean) => void;
}) {
  const visibility = productVisibility(product);
  const button = activeToggle(product);

  return (
    <tr>
      <td>
        <strong>{product.name}</strong>
        <div className="muted small">{product.category_name ?? 'No category'}</div>
      </td>
      <td>
        {product.vendor.business_name}
        <div className="muted small">{product.vendor.status}</div>
      </td>
      <td className="num">{formatNpr(product.price_npr)}</td>
      <td className={`num ${product.stock_quantity === 0 ? 'negative' : ''}`}>
        {stockLabel(product)}
      </td>
      <td>
        <div className="confirm">
          <span className={`badge ${visibility.visible ? 'status-replayed' : 'status-pending'}`}>
            {visibility.label}
          </span>
          <button
            type="button"
            className={`button ${button.next ? 'primary' : 'danger-outline'}`}
            disabled={saving}
            aria-label={`${button.label} ${product.name}`}
            onClick={() => {
              onToggle(button.next);
            }}
          >
            {saving ? 'Saving…' : button.label}
          </button>
        </div>
        {error !== null && (
          <div className="error small" role="alert">
            {error}
          </div>
        )}
      </td>
    </tr>
  );
}
