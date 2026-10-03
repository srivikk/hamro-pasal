import type { AdminCategoryView, AdminCategoryWrite } from '@hamro-pasal/shared-types';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState, type SyntheticEvent } from 'react';

import { ApiError } from '../../api/client';
import { useAdminApi } from '../../app-context';
import {
  canHaveChildren,
  categoryErrorMessage,
  categoryRows,
  deleteBlockedReason,
  emptyCategoryForm,
  formFromCategory,
  parentOptions,
  validateCategoryForm,
  withName,
  type CategoryFormField,
  type CategoryFormValues,
  type CategoryRow,
} from './category-rules';

export const CATEGORIES_KEY = ['admin', 'categories'] as const;

/** What the modal is doing: creating (optionally under a parent) or editing one category. */
type Editor =
  | { readonly mode: 'create'; readonly parentId: string | null }
  | { readonly mode: 'edit'; readonly category: AdminCategoryView };

/**
 * Phase 17: the Master Category Taxonomy (SPEC Super Admin flow 2) as a tree, with a modal to
 * create and edit categories. Vendors map their products to these; customers browse the active ones.
 */
export function CategoryScreen() {
  const api = useAdminApi();
  const queryClient = useQueryClient();
  const [editor, setEditor] = useState<Editor | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});

  const query = useQuery({ queryKey: CATEGORIES_KEY, queryFn: () => api.listCategories() });

  const remove = useMutation({
    mutationFn: (id: string) => api.deleteCategory(id),
    onMutate: (id) => {
      setConfirming(null);
      setErrors(({ [id]: _cleared, ...rest }) => rest);
    },
    onError: (error, id) => {
      setErrors((current) => ({ ...current, [id]: categoryErrorMessage(error) }));
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: CATEGORIES_KEY }),
  });

  if (query.isPending) return <p className="muted">Loading…</p>;
  if (query.isError) {
    return (
      <p className="error" role="alert">
        {query.error instanceof ApiError && query.error.code === 'NETWORK_ERROR'
          ? 'The API cannot be reached.'
          : 'The categories could not be loaded.'}{' '}
        <button type="button" className="link" onClick={() => void query.refetch()}>
          Try again
        </button>
      </p>
    );
  }

  const rows = categoryRows(query.data.categories);
  const hidden = rows.filter((row) => !row.is_active).length;

  return (
    <section>
      <div className="section-head">
        <div>
          <h2>Categories</h2>
          <p className="muted">
            {rows.length} categories · {hidden} hidden. Vendors map products to these; customers see
            the active ones. Hiding a category hides everything under it.
          </p>
        </div>
        <button
          type="button"
          className="button primary"
          onClick={() => {
            setEditor({ mode: 'create', parentId: null });
          }}
        >
          New category
        </button>
      </div>

      {rows.length === 0 ? (
        <p className="empty">No categories yet. Create the first one.</p>
      ) : (
        <ul className="tree" aria-label="Category tree">
          {rows.map((row) => (
            <CategoryItem
              key={row.id}
              row={row}
              confirming={confirming === row.id}
              deleting={remove.isPending && remove.variables === row.id}
              error={errors[row.id] ?? null}
              onAddChild={() => {
                setEditor({ mode: 'create', parentId: row.id });
              }}
              onEdit={() => {
                setEditor({ mode: 'edit', category: row });
              }}
              onAskDelete={() => {
                setConfirming(row.id);
              }}
              onCancelDelete={() => {
                setConfirming(null);
              }}
              onConfirmDelete={() => {
                remove.mutate(row.id);
              }}
            />
          ))}
        </ul>
      )}

      {editor !== null && (
        <CategoryModal
          // A fresh form per target, so one category's values never leak into the next.
          key={editor.mode === 'edit' ? editor.category.id : `new-${editor.parentId ?? 'root'}`}
          editor={editor}
          rows={rows}
          onClose={() => {
            setEditor(null);
          }}
        />
      )}
    </section>
  );
}

function CategoryItem({
  row,
  confirming,
  deleting,
  error,
  onAddChild,
  onEdit,
  onAskDelete,
  onCancelDelete,
  onConfirmDelete,
}: {
  readonly row: CategoryRow;
  readonly confirming: boolean;
  readonly deleting: boolean;
  readonly error: string | null;
  readonly onAddChild: () => void;
  readonly onEdit: () => void;
  readonly onAskDelete: () => void;
  readonly onCancelDelete: () => void;
  readonly onConfirmDelete: () => void;
}) {
  const blocked = deleteBlockedReason(row);

  return (
    <li className={`tree-row depth-${String(row.depth)}`}>
      <div className="tree-main">
        <div className="tree-title">
          <strong>{row.name}</strong>
          <span className={`badge ${row.is_active ? 'status-replayed' : 'status-pending'}`}>
            {row.is_active ? 'Active' : 'Hidden'}
          </span>
        </div>
        <div className="muted small">
          <span className="mono">{row.slug}</span> · order {row.display_order} · {row.product_count}{' '}
          product{row.product_count === 1 ? '' : 's'}
        </div>
        {error !== null && (
          <div className="error small" role="alert">
            {error}
          </div>
        )}
      </div>
      <div className="tree-actions">
        {canHaveChildren(row) && (
          <button type="button" className="button ghost" onClick={onAddChild}>
            Add subcategory
          </button>
        )}
        <button type="button" className="button" onClick={onEdit}>
          Edit
        </button>
        {confirming ? (
          <span className="confirm">
            <button type="button" className="button danger" onClick={onConfirmDelete}>
              Confirm delete
            </button>
            <button type="button" className="button ghost" onClick={onCancelDelete}>
              Cancel
            </button>
          </span>
        ) : (
          <button
            type="button"
            className="button danger-outline"
            disabled={blocked !== null || deleting}
            title={blocked ?? undefined}
            onClick={onAskDelete}
          >
            {deleting ? 'Deleting…' : 'Delete'}
          </button>
        )}
      </div>
    </li>
  );
}

function CategoryModal({
  editor,
  rows,
  onClose,
}: {
  readonly editor: Editor;
  readonly rows: readonly CategoryRow[];
  readonly onClose: () => void;
}) {
  const api = useAdminApi();
  const queryClient = useQueryClient();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const formId = useId();
  const editing = editor.mode === 'edit' ? editor.category : null;
  const [values, setValues] = useState<CategoryFormValues>(() =>
    editing === null
      ? emptyCategoryForm(editor.mode === 'create' ? editor.parentId : null)
      : formFromCategory(editing),
  );
  const [fieldErrors, setFieldErrors] = useState<
    Readonly<Partial<Record<CategoryFormField, string>>>
  >({});

  // A native modal dialog: focus is trapped inside it and Escape closes it.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog !== null && !dialog.open) dialog.showModal();
  }, []);

  const save = useMutation({
    mutationFn: (request: AdminCategoryWrite) =>
      editing === null ? api.createCategory(request) : api.updateCategory(editing.id, request),
    onSuccess: onClose,
    // Refreshed after a failure too: a 409 / 422 usually means the list on screen was stale.
    onSettled: () => queryClient.invalidateQueries({ queryKey: CATEGORIES_KEY }),
  });

  const submit = (event: SyntheticEvent) => {
    event.preventDefault();
    const result = validateCategoryForm(values);
    if (!result.ok) {
      setFieldErrors(result.errors);
      return;
    }
    setFieldErrors({});
    save.mutate(result.request);
  };

  const field = (name: CategoryFormField) => `${formId}-${name}`;
  const errorOf = (name: CategoryFormField) =>
    fieldErrors[name] === undefined ? null : (
      <span className="error small" role="alert">
        {fieldErrors[name]}
      </span>
    );

  return (
    <dialog ref={dialogRef} className="modal" aria-labelledby={`${formId}-title`} onClose={onClose}>
      <form onSubmit={submit} noValidate>
        <h2 id={`${formId}-title`}>{editing === null ? 'New category' : `Edit ${editing.name}`}</h2>

        <label htmlFor={field('name')}>Name</label>
        <input
          id={field('name')}
          value={values.name}
          maxLength={80}
          autoFocus
          onChange={(event) => {
            setValues((current) => withName(current, event.target.value));
          }}
        />
        {errorOf('name')}

        <label htmlFor={field('slug')}>Slug</label>
        <input
          id={field('slug')}
          className="mono"
          value={values.slug}
          maxLength={80}
          onChange={(event) => {
            setValues((current) => ({ ...current, slug: event.target.value }));
          }}
        />
        {errorOf('slug')}

        <label htmlFor={field('parentId')}>Parent</label>
        <select
          id={field('parentId')}
          value={values.parentId}
          onChange={(event) => {
            setValues((current) => ({ ...current, parentId: event.target.value }));
          }}
        >
          <option value="">None (top level)</option>
          {parentOptions(rows, editing?.id ?? null).map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
        {errorOf('parentId')}

        <label htmlFor={field('iconUrl')}>Icon URL (optional)</label>
        <input
          id={field('iconUrl')}
          type="url"
          value={values.iconUrl}
          placeholder="https://…"
          onChange={(event) => {
            setValues((current) => ({ ...current, iconUrl: event.target.value }));
          }}
        />
        {errorOf('iconUrl')}

        <label htmlFor={field('displayOrder')}>Display order</label>
        <input
          id={field('displayOrder')}
          inputMode="numeric"
          value={values.displayOrder}
          onChange={(event) => {
            setValues((current) => ({ ...current, displayOrder: event.target.value }));
          }}
        />
        {errorOf('displayOrder')}

        <label className="check">
          <input
            type="checkbox"
            checked={values.isActive}
            onChange={(event) => {
              setValues((current) => ({ ...current, isActive: event.target.checked }));
            }}
          />
          Active (visible to vendors and customers)
        </label>

        {save.isError && (
          <p className="error" role="alert">
            {categoryErrorMessage(save.error)}
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
