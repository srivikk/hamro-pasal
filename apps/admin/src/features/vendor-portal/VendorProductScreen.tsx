import type {
  CategoryView,
  VendorProductListResponseBody,
  VendorProductUpdate,
  VendorProductView,
} from '@hamro-pasal/shared-types';
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
  type QueryClient,
} from '@tanstack/react-query';
import { useEffect, useId, useRef, useState, type SyntheticEvent } from 'react';

import { ApiError } from '../../api/client';
import { useAdminApi } from '../../app-context';
import { formatNpr } from '../../lib/format';
import {
  addedUrls,
  categoryLabel,
  categoryOptions,
  formFromProduct,
  parseStock,
  replaceOwnProduct,
  availabilityOf,
  uploadProblem,
  validateProductForm,
  vendorProductErrorMessage,
  type ProductFormField,
  type ProductFormValues,
} from './vendor-product-rules';

type ProductPages = InfiniteData<VendorProductListResponseBody, string | null>;

const OWN_PRODUCTS_KEY = ['vendor', 'products'] as const;
const ACTIVE_CATEGORIES_KEY = ['categories', 'active'] as const;

/** Shows a saved product at once, in place: refetching every loaded page is not needed. */
function putInCache(queryClient: QueryClient, product: VendorProductView): void {
  queryClient.setQueryData<ProductPages>(OWN_PRODUCTS_KEY, (current) =>
    current === undefined
      ? current
      : { ...current, pages: replaceOwnProduct(current.pages, product) },
  );
}

/**
 * Phase 19, the Vendor Portal: the signed-in vendor's own catalogue. Each row sets the stock and
 * hides or shows the product; Edit opens the details, category and photos. Every call goes to
 * /api/vendor/products, where the server takes the shop from the token.
 */
export function VendorProductScreen() {
  const api = useAdminApi();
  const queryClient = useQueryClient();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});

  const categories = useQuery({
    queryKey: ACTIVE_CATEGORIES_KEY,
    queryFn: () => api.listActiveCategories(),
    staleTime: 5 * 60_000,
  });

  const query = useInfiniteQuery({
    queryKey: OWN_PRODUCTS_KEY,
    queryFn: ({ pageParam }) => api.listOwnProducts({ cursor: pageParam ?? undefined }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next_cursor,
  });

  const clearError = (id: string) => {
    setErrors(({ [id]: _cleared, ...rest }) => rest);
  };
  const onRowError = (error: unknown, id: string) => {
    setErrors((current) => ({ ...current, [id]: vendorProductErrorMessage(error) }));
    void queryClient.invalidateQueries({ queryKey: OWN_PRODUCTS_KEY });
  };

  const stock = useMutation({
    mutationFn: ({ id, quantity }: { readonly id: string; readonly quantity: number }) =>
      api.setOwnProductStock(id, quantity),
    onMutate: ({ id }) => {
      clearError(id);
    },
    onSuccess: ({ product }) => {
      putInCache(queryClient, product);
    },
    onError: (error, { id }) => {
      onRowError(error, id);
    },
  });

  const hide = useMutation({
    mutationFn: (product: VendorProductView) => api.setOwnProductAvailability(product.id, false),
    onMutate: (product) => {
      setConfirming(null);
      clearError(product.id);
    },
    onSuccess: ({ product }) => {
      putInCache(queryClient, product);
    },
    onError: (error, product) => {
      onRowError(error, product.id);
    },
  });

  const show = useMutation({
    mutationFn: ({ id }: { readonly id: string }) => api.setOwnProductAvailability(id, true),
    onMutate: ({ id }) => {
      clearError(id);
    },
    onSuccess: ({ product }) => {
      putInCache(queryClient, product);
    },
    onError: (error, { id }) => {
      onRowError(error, id);
    },
  });

  const products = query.data?.pages.flatMap((page) => page.products) ?? [];
  const editing = products.find((product) => product.id === editingId) ?? null;
  const taxonomy = categories.data?.categories ?? [];
  const hidden = products.filter((product) => availabilityOf(product) !== 'IN_STOCK').length;

  return (
    <section>
      <div className="section-head">
        <div>
          <h2>My products</h2>
          <p className="muted">
            {query.isSuccess
              ? `${String(products.length)}${query.hasNextPage ? '+' : ''} products · ${String(hidden)} not orderable. `
              : ''}
            Customers see your products with the stock you set here. Marking one out of stock keeps
            it listed but stops orders, without changing its count. Hamro Pasal may hide a product;
            that is shown here and only Hamro Pasal can undo it.
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

      {query.isPending ? (
        <p className="muted">Loading…</p>
      ) : query.isError ? (
        <p className="error" role="alert">
          {query.error instanceof ApiError &&
          ['NETWORK_ERROR', 'VENDOR_NOT_FOUND', 'FORBIDDEN'].includes(query.error.code)
            ? vendorProductErrorMessage(query.error)
            : 'Your products could not be loaded.'}{' '}
          <button type="button" className="link" onClick={() => void query.refetch()}>
            Try again
          </button>
        </p>
      ) : products.length === 0 ? (
        <p className="empty">Your shop has no products yet.</p>
      ) : (
        <>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Photo</th>
                  <th scope="col">Product</th>
                  <th scope="col" className="num">
                    Price
                  </th>
                  <th scope="col">Stock</th>
                  <th scope="col">Customers</th>
                  <th scope="col">
                    <span className="visually-hidden">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {products.map((product) => (
                  <ProductRow
                    // A new key when the server's stock changes resets the typed value to it.
                    key={`${product.id}:${String(product.stock_quantity)}`}
                    product={product}
                    category={categoryLabel(taxonomy, product.category_id)}
                    savingStock={stock.isPending && stock.variables.id === product.id}
                    toggling={
                      (hide.isPending && hide.variables.id === product.id) ||
                      (show.isPending && show.variables.id === product.id)
                    }
                    confirming={confirming === product.id}
                    error={errors[product.id] ?? null}
                    onSaveStock={(quantity) => {
                      stock.mutate({ id: product.id, quantity });
                    }}
                    onAskHide={() => {
                      setConfirming(product.id);
                    }}
                    onCancelHide={() => {
                      setConfirming(null);
                    }}
                    onConfirmHide={() => {
                      hide.mutate(product);
                    }}
                    onShow={() => {
                      show.mutate({ id: product.id });
                    }}
                    onEdit={() => {
                      setEditingId(product.id);
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

      {editing !== null && (
        <ProductModal
          // A fresh form per product, so one product's values never leak into the next.
          key={editing.id}
          product={editing}
          categories={taxonomy}
          onClose={() => {
            setEditingId(null);
          }}
        />
      )}
    </section>
  );
}

function ProductRow({
  product,
  category,
  savingStock,
  toggling,
  confirming,
  error,
  onSaveStock,
  onAskHide,
  onCancelHide,
  onConfirmHide,
  onShow,
  onEdit,
}: {
  readonly product: VendorProductView;
  readonly category: string;
  readonly savingStock: boolean;
  readonly toggling: boolean;
  readonly confirming: boolean;
  readonly error: string | null;
  readonly onSaveStock: (quantity: number) => void;
  readonly onAskHide: () => void;
  readonly onCancelHide: () => void;
  readonly onConfirmHide: () => void;
  readonly onShow: () => void;
  readonly onEdit: () => void;
}) {
  const [typed, setTyped] = useState(String(product.stock_quantity));
  const quantity = parseStock(typed);
  const changed = quantity !== product.stock_quantity;
  const [thumbnail] = product.image_urls;
  const availability = availabilityOf(product);

  return (
    <tr>
      <td>
        {thumbnail === undefined ? (
          <div className="thumb thumb-empty" aria-label="No photo">
            —
          </div>
        ) : (
          <img className="thumb" src={thumbnail} alt="" loading="lazy" />
        )}
        {product.image_urls.length > 1 && (
          <div className="muted small">+{product.image_urls.length - 1} more</div>
        )}
      </td>
      <td>
        <strong>{product.name}</strong>
        <div className="muted small">{category}</div>
        {product.description !== null && (
          <div className="muted small note">{product.description}</div>
        )}
        {error !== null && (
          <div className="error small" role="alert">
            {error}
          </div>
        )}
      </td>
      <td className="num">
        {formatNpr(product.price_npr)}
        <div className="muted small">per {product.unit}</div>
      </td>
      <td>
        <form
          className="confirm"
          onSubmit={(event) => {
            event.preventDefault();
            if (quantity !== null && changed) onSaveStock(quantity);
          }}
        >
          <input
            className={`stock-input ${product.stock_quantity === 0 ? 'negative' : ''}`}
            inputMode="numeric"
            aria-label={`Stock of ${product.name}`}
            aria-invalid={quantity === null}
            value={typed}
            onChange={(event) => {
              setTyped(event.target.value);
            }}
          />
          <button
            type="submit"
            className="button"
            disabled={quantity === null || !changed || savingStock}
          >
            {savingStock ? 'Saving…' : 'Set'}
          </button>
        </form>
        {quantity === null ? (
          <div className="error small">Enter a whole number, 0 or more.</div>
        ) : (
          product.stock_quantity === 0 && <div className="muted small">Out of stock</div>
        )}
      </td>
      <td>
        <div className="confirm">
          <span
            className={`badge ${availability === 'IN_STOCK' ? 'status-replayed' : 'status-pending'}`}
          >
            {availability === 'HIDDEN_BY_ADMIN'
              ? 'Hidden by Hamro Pasal'
              : availability === 'IN_STOCK'
                ? 'In stock'
                : 'Out of stock'}
          </span>
          {availability === 'HIDDEN_BY_ADMIN' ? null : availability === 'OUT_OF_STOCK' ? (
            <button
              type="button"
              className="button primary"
              disabled={toggling}
              aria-label={`Mark ${product.name} in stock`}
              onClick={onShow}
            >
              {toggling ? 'Saving…' : 'Mark in stock'}
            </button>
          ) : confirming ? (
            <>
              <button type="button" className="button danger" onClick={onConfirmHide}>
                Confirm out of stock
              </button>
              <button type="button" className="button ghost" onClick={onCancelHide}>
                Cancel
              </button>
            </>
          ) : (
            <button
              type="button"
              className="button danger-outline"
              disabled={toggling}
              aria-label={`Mark ${product.name} out of stock`}
              onClick={onAskHide}
            >
              {toggling ? 'Saving…' : 'Out of stock'}
            </button>
          )}
        </div>
      </td>
      <td>
        <button
          type="button"
          className="button"
          aria-label={`Edit ${product.name}`}
          onClick={onEdit}
        >
          Edit
        </button>
      </td>
    </tr>
  );
}

function ProductModal({
  product,
  categories,
  onClose,
}: {
  readonly product: VendorProductView;
  readonly categories: readonly CategoryView[];
  readonly onClose: () => void;
}) {
  const api = useAdminApi();
  const queryClient = useQueryClient();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const formId = useId();
  const [values, setValues] = useState<ProductFormValues>(() => formFromProduct(product));
  const [fieldErrors, setFieldErrors] = useState<
    Readonly<Partial<Record<ProductFormField, string>>>
  >({});
  const [uploadMessage, setUploadMessage] = useState<string | null>(null);

  // A native modal dialog: focus is trapped inside it and Escape closes it.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog !== null && !dialog.open) dialog.showModal();
  }, []);

  const save = useMutation({
    mutationFn: (request: VendorProductUpdate) => api.updateOwnProduct(product.id, request),
    onSuccess: ({ product: saved }) => {
      putInCache(queryClient, saved);
      onClose();
    },
    onError: () => queryClient.invalidateQueries({ queryKey: OWN_PRODUCTS_KEY }),
  });

  // Photos are stored as soon as they are uploaded (not on Save): the server appends them.
  const upload = useMutation({
    mutationFn: (files: readonly File[]) => api.uploadOwnProductImages(product.id, files),
    onSuccess: ({ product: saved }) => {
      const added = addedUrls(product.image_urls, saved.image_urls);
      putInCache(queryClient, saved);
      setValues((current) => ({ ...current, imageUrls: [...current.imageUrls, ...added] }));
      setUploadMessage(null);
      if (fileRef.current !== null) fileRef.current.value = '';
    },
    onError: (error) => {
      setUploadMessage(vendorProductErrorMessage(error));
    },
  });

  const submit = (event: SyntheticEvent) => {
    event.preventDefault();
    const result = validateProductForm(values, product);
    if (!result.ok) {
      setFieldErrors(result.errors);
      return;
    }
    setFieldErrors({});
    save.mutate(result.request);
  };

  const onUpload = () => {
    const files = Array.from(fileRef.current?.files ?? []);
    // Counted against what the server holds: a photo marked "Remove" still takes a slot until Save.
    const problem = uploadProblem(files, product.image_urls.length);
    if (problem !== null) {
      setUploadMessage(problem);
      return;
    }
    upload.mutate(files);
  };

  const field = (name: ProductFormField) => `${formId}-${name}`;
  const errorOf = (name: ProductFormField) =>
    fieldErrors[name] === undefined ? null : (
      <span className="error small" role="alert">
        {fieldErrors[name]}
      </span>
    );
  const removed = product.image_urls.length - values.imageUrls.length;

  return (
    <dialog
      ref={dialogRef}
      className="modal modal-wide"
      aria-labelledby={`${formId}-title`}
      onClose={onClose}
    >
      <form onSubmit={submit} noValidate>
        <h2 id={`${formId}-title`}>Edit {product.name}</h2>

        <label htmlFor={field('name')}>Name</label>
        <input
          id={field('name')}
          value={values.name}
          maxLength={120}
          autoFocus
          onChange={(event) => {
            setValues((current) => ({ ...current, name: event.target.value }));
          }}
        />
        {errorOf('name')}

        <label htmlFor={field('categoryId')}>Category</label>
        <select
          id={field('categoryId')}
          value={values.categoryId}
          onChange={(event) => {
            setValues((current) => ({ ...current, categoryId: event.target.value }));
          }}
        >
          <option value="">Choose a category</option>
          {categoryOptions(categories, product.category_id).map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
        {errorOf('categoryId')}

        <label htmlFor={field('description')}>Description (optional)</label>
        <textarea
          id={field('description')}
          rows={3}
          maxLength={2000}
          value={values.description}
          onChange={(event) => {
            setValues((current) => ({ ...current, description: event.target.value }));
          }}
        />
        {errorOf('description')}

        <div className="field-pair">
          <div>
            <label htmlFor={field('price')}>Price (Rs.)</label>
            <input
              id={field('price')}
              inputMode="decimal"
              value={values.price}
              onChange={(event) => {
                setValues((current) => ({ ...current, price: event.target.value }));
              }}
            />
            {errorOf('price')}
          </div>
          <div>
            <label htmlFor={field('unit')}>Sold per</label>
            <input
              id={field('unit')}
              value={values.unit}
              maxLength={20}
              placeholder="piece, kg, pack…"
              onChange={(event) => {
                setValues((current) => ({ ...current, unit: event.target.value }));
              }}
            />
            {errorOf('unit')}
          </div>
        </div>

        <fieldset className="photos">
          <legend>
            Photos ({values.imageUrls.length} of 8
            {removed > 0 ? `, ${String(removed)} removed when you save` : ''})
          </legend>
          {values.imageUrls.length === 0 ? (
            <p className="muted small">No photos yet.</p>
          ) : (
            <ul className="photo-grid">
              {values.imageUrls.map((url, index) => (
                <li key={url}>
                  <img src={url} alt={`${product.name}, photo ${String(index + 1)}`} />
                  <button
                    type="button"
                    className="link"
                    onClick={() => {
                      setValues((current) => ({
                        ...current,
                        imageUrls: current.imageUrls.filter((kept) => kept !== url),
                      }));
                    }}
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="confirm">
            <input
              ref={fileRef}
              type="file"
              name="images"
              accept="image/jpeg,image/png,image/webp"
              multiple
              aria-label="Photos to upload"
            />
            <button type="button" className="button" disabled={upload.isPending} onClick={onUpload}>
              {upload.isPending ? 'Uploading…' : 'Upload'}
            </button>
          </div>
          <p className="muted small">JPEG, PNG or WebP, at most 5 MB each.</p>
          {uploadMessage !== null && (
            <p className="error small" role="alert">
              {uploadMessage}
            </p>
          )}
        </fieldset>

        {save.isError && (
          <p className="error" role="alert">
            {vendorProductErrorMessage(save.error)}
          </p>
        )}

        <div className="modal-actions">
          <button type="button" className="button ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="button primary" disabled={save.isPending}>
            {save.isPending ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </dialog>
  );
}
