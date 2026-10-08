import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState, type SyntheticEvent } from 'react';

import { ApiError } from '../../api/client';
import { useAdminApi } from '../../app-context';
import {
  AD_BILLING_LABELS,
  AD_SLOT_LABELS,
  adBillingModels,
  adPriceLabel,
  adProductRows,
  adProductSaveErrorMessage,
  adSlots,
  emptyAdProductForm,
  formFromAdProduct,
  offSaleNote,
  PRICE_FIELD_LABELS,
  validateAdProductEdit,
  validateNewAdProduct,
  type AdProductFormField,
  type AdProductFormValues,
  type AdProductView,
} from './ad-product-rules';

const AD_PRODUCTS_KEY = ['admin', 'ad-products'] as const;

/** What the modal is doing: creating a product or editing one. */
type Editor =
  { readonly mode: 'create' } | { readonly mode: 'edit'; readonly product: AdProductView };

/**
 * The Ad Marketplace price list (SPEC core section 8): the sponsored placements vendors can buy.
 * An admin publishes prices and nothing more: an ad, and its charge, exist only when a vendor buys
 * one in the Vendor App. This screen has no control that books an ad for a shop, and must never
 * get one. Reads and writes /api/admin/ads/products.
 */
export function AdProductScreen() {
  const api = useAdminApi();
  const [editor, setEditor] = useState<Editor | null>(null);
  const query = useQuery({ queryKey: AD_PRODUCTS_KEY, queryFn: () => api.listAdProducts() });

  if (query.isPending) return <p className="muted">Loading…</p>;
  if (query.isError) {
    return (
      <p className="error" role="alert">
        {query.error instanceof ApiError && query.error.code === 'NETWORK_ERROR'
          ? 'The API cannot be reached.'
          : 'The ad products could not be loaded.'}{' '}
        <button type="button" className="link" onClick={() => void query.refetch()}>
          Try again
        </button>
      </p>
    );
  }

  const { products } = query.data;

  const rows = adProductRows(products);
  const onSale = products.filter((product) => product.is_active).length;

  return (
    <section>
      <div className="section-head">
        <div>
          <h2>Ad products</h2>
          <p className="muted">
            {products.length} products · {onSale} on sale. This is a price list, not a charge: a
            vendor is billed for an ad only after buying it in the Vendor App and agreeing to its
            price. A product’s placement, billing model, price and duration never change: publish a
            new product and take the old one off sale.
          </p>
        </div>
        <button
          type="button"
          className="button primary"
          onClick={() => {
            setEditor({ mode: 'create' });
          }}
        >
          New ad product
        </button>
      </div>

      {rows.length === 0 ? (
        <p className="empty">No ad products yet.</p>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Product</th>
                <th scope="col">Placement</th>
                <th scope="col">Billing</th>
                <th scope="col">Price</th>
                <th scope="col" className="num">
                  Running purchases
                </th>
                <th scope="col">Status</th>
                <th scope="col">
                  <span className="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((product) => (
                <tr key={product.id}>
                  <td>
                    <strong>{product.name}</strong>
                  </td>
                  <td>{AD_SLOT_LABELS[product.slot]}</td>
                  <td>{AD_BILLING_LABELS[product.billing_model]}</td>
                  <td>{adPriceLabel(product)}</td>
                  <td className="num">{product.active_purchase_count}</td>
                  <td>
                    <span
                      className={`badge ${product.is_active ? 'plan-offered' : 'plan-withdrawn'}`}
                    >
                      {product.is_active ? 'On sale' : 'Off sale'}
                    </span>
                  </td>
                  <td>
                    <button
                      type="button"
                      className="button"
                      onClick={() => {
                        setEditor({ mode: 'edit', product });
                      }}
                    >
                      Edit
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editor !== null && (
        <AdProductModal
          // A fresh form per target, so one product's values never leak into the next.
          key={editor.mode === 'edit' ? editor.product.id : 'new'}
          editor={editor}
          onSaved={() => {
            setEditor(null);
          }}
          onClose={() => {
            setEditor(null);
          }}
        />
      )}
    </section>
  );
}

function AdProductModal({
  editor,
  onSaved,
  onClose,
}: {
  readonly editor: Editor;
  readonly onSaved: () => void;
  readonly onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const formId = useId();
  const editing = editor.mode === 'edit' ? editor.product : null;
  const [values, setValues] = useState<AdProductFormValues>(() =>
    editing === null ? emptyAdProductForm() : formFromAdProduct(editing),
  );
  const [fieldErrors, setFieldErrors] = useState<
    Readonly<Partial<Record<AdProductFormField, string>>>
  >({});
  const [formError, setFormError] = useState<string | null>(null);

  const api = useAdminApi();
  const queryClient = useQueryClient();
  const save = useMutation({
    // The create and the edit send different bodies; each call site hands over its own request.
    mutationFn: (send: () => Promise<unknown>) => send(),
    onSuccess: onSaved,
    onError: (error) => {
      setFormError(adProductSaveErrorMessage(error));
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: AD_PRODUCTS_KEY }),
  });

  // A native modal dialog: focus is trapped inside it and Escape closes it.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog !== null && !dialog.open) dialog.showModal();
  }, []);

  const submit = (event: SyntheticEvent) => {
    event.preventDefault();
    if (save.isPending) return;
    setFormError(null);
    if (editing === null) {
      const result = validateNewAdProduct(values);
      if (!result.ok) {
        setFieldErrors(result.errors);
        return;
      }
      setFieldErrors({});
      save.mutate(() => api.createAdProduct(result.request));
      return;
    }
    const result = validateAdProductEdit(values);
    if (!result.ok) {
      setFieldErrors(result.errors);
      return;
    }
    setFieldErrors({});
    save.mutate(() => api.updateAdProduct(editing.id, result.request));
  };

  const field = (name: AdProductFormField | 'slot' | 'billingModel') => `${formId}-${name}`;
  const errorOf = (name: AdProductFormField) =>
    fieldErrors[name] === undefined ? null : (
      <span className="error small" role="alert">
        {fieldErrors[name]}
      </span>
    );
  const locked = editing !== null;
  const note = values.isActive ? null : offSaleNote(editing);

  return (
    <dialog ref={dialogRef} className="modal" aria-labelledby={`${formId}-title`} onClose={onClose}>
      <form onSubmit={submit} noValidate>
        <h2 id={`${formId}-title`}>
          {editing === null ? 'New ad product' : `Edit ${editing.name}`}
        </h2>

        <label htmlFor={field('name')}>Name</label>
        <input
          id={field('name')}
          value={values.name}
          maxLength={80}
          placeholder="Home Page Carousel"
          autoFocus
          onChange={(event) => {
            setValues((current) => ({ ...current, name: event.target.value }));
          }}
        />
        {errorOf('name')}

        <div className="field-pair">
          <div>
            <label htmlFor={field('slot')}>Placement</label>
            <select
              id={field('slot')}
              value={values.slot}
              disabled={locked}
              onChange={(event) => {
                const slot = adSlots.find((candidate) => candidate === event.target.value);
                if (slot !== undefined) setValues((current) => ({ ...current, slot }));
              }}
            >
              {adSlots.map((slot) => (
                <option key={slot} value={slot}>
                  {AD_SLOT_LABELS[slot]}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor={field('billingModel')}>Billing model</label>
            <select
              id={field('billingModel')}
              value={values.billingModel}
              disabled={locked}
              onChange={(event) => {
                const billingModel = adBillingModels.find(
                  (candidate) => candidate === event.target.value,
                );
                if (billingModel !== undefined) {
                  // 5000 for a period is not 5000 per order.
                  setValues((current) => ({ ...current, billingModel, price: '' }));
                }
              }}
            >
              {adBillingModels.map((model) => (
                <option key={model} value={model}>
                  {AD_BILLING_LABELS[model]}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="field-pair">
          <div>
            <label htmlFor={field('price')}>{PRICE_FIELD_LABELS[values.billingModel]}</label>
            <input
              id={field('price')}
              inputMode="decimal"
              value={values.price}
              disabled={locked}
              onChange={(event) => {
                setValues((current) => ({ ...current, price: event.target.value }));
              }}
            />
            {errorOf('price')}
          </div>
          <div>
            <label htmlFor={field('durationDays')}>Runs for (days)</label>
            <input
              id={field('durationDays')}
              inputMode="numeric"
              value={values.durationDays}
              disabled={locked}
              onChange={(event) => {
                setValues((current) => ({ ...current, durationDays: event.target.value }));
              }}
            />
            {errorOf('durationDays')}
          </div>
        </div>
        {locked && (
          <span className="muted small">
            The placement, billing model, price and duration of an existing product are locked:
            vendors bought at these terms. To change a price, publish a new product and take this
            one off sale.
          </span>
        )}

        <label className="check">
          <input
            type="checkbox"
            checked={values.isActive}
            onChange={(event) => {
              setValues((current) => ({ ...current, isActive: event.target.checked }));
            }}
          />
          On sale in the Ad Marketplace
        </label>
        {note !== null && <span className="muted small">{note}</span>}

        <p className="guardrail">
          You cannot book an ad for a shop. A vendor is charged only for a product its own account
          bought in the Vendor App, at the price shown here on that day.
        </p>

        {formError !== null && (
          <p className="error" role="alert">
            {formError}
          </p>
        )}

        <div className="modal-actions">
          <button type="button" className="button ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="button primary" disabled={save.isPending}>
            {save.isPending ? 'Saving…' : editing === null ? 'Create' : 'Save'}
          </button>
        </div>
      </form>
    </dialog>
  );
}
