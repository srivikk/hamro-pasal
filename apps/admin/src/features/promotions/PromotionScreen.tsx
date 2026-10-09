import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState, type SyntheticEvent } from 'react';

import { ApiError } from '../../api/client';
import { useAdminApi } from '../../app-context';
import { nepalDay } from '../campaigns/campaign-rules';
import {
  emptyPromotionForm,
  formFromPromotion,
  PROMOTION_IMAGE_ACCEPT,
  PROMOTION_PHASE_LABELS,
  PROMOTION_PLACEMENT_LABELS,
  PROMOTION_TARGET_LABELS,
  promotionActionErrorMessage,
  promotionImageProblem,
  promotionImageUploadError,
  promotionPhase,
  promotionPlacements,
  promotionRows,
  promotionSaveError,
  promotionTargetTypes,
  SPONSORSHIP_AVAILABLE,
  TARGET_FIELD,
  targetLabel,
  unusedUploads,
  validatePromotionForm,
  visibilityRequest,
  withTargetType,
  type AdminPromotionView,
  type PromotionFormField,
  type PromotionFormValues,
  type PromotionWrite,
} from './promotion-rules';

const PROMOTIONS_KEY = ['admin', 'promotions'] as const;

/** What the modal is doing: creating a promotion or editing one. */
type Editor =
  { readonly mode: 'create' } | { readonly mode: 'edit'; readonly promotion: AdminPromotionView };

/**
 * Home promotions (STATE_HANDOFF §8Z.4): the banner carousel and the Featured Offers tiles of the
 * customer app's Home. A promotion opens a shop or filters Home; it never changes a price. One is
 * marked as an ad only together with the purchase a vendor made in the Ad Marketplace: the form
 * takes that purchase's id and the server checks it (`SPONSORSHIP_AVAILABLE`).
 * Reads and writes /api/admin/promotions. Artwork is a file the admin picks: it is uploaded to
 * POST /api/admin/promotions/image at once and the promotion saves the URL that comes back.
 */
export function PromotionScreen() {
  const api = useAdminApi();
  const queryClient = useQueryClient();
  const [editor, setEditor] = useState<Editor | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const query = useQuery({ queryKey: PROMOTIONS_KEY, queryFn: () => api.listPromotions() });

  const rowAction = {
    onMutate: () => {
      setDeleting(null);
      setActionError(null);
    },
    onError: (error: unknown) => {
      setActionError(promotionActionErrorMessage(error));
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: PROMOTIONS_KEY }),
  };
  // Hide / Show from a row: PUT replaces the row, so every field is sent as it is.
  const setVisible = useMutation({
    mutationFn: ({ promotion, isActive }: { promotion: AdminPromotionView; isActive: boolean }) =>
      api.updatePromotion(promotion.id, visibilityRequest(promotion, isActive)),
    ...rowAction,
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.deletePromotion(id),
    ...rowAction,
  });
  const busy = setVisible.isPending || remove.isPending;

  if (query.isPending) return <p className="muted">Loading…</p>;
  if (query.isError) {
    return (
      <p className="error" role="alert">
        {query.error instanceof ApiError && query.error.code === 'NETWORK_ERROR'
          ? 'The API cannot be reached.'
          : 'The promotions could not be loaded.'}{' '}
        <button type="button" className="link" onClick={() => void query.refetch()}>
          Try again
        </button>
      </p>
    );
  }

  const { promotions } = query.data;

  const now = new Date().toISOString();
  const rows = promotionRows(promotions);
  const live = promotions.filter((promotion) => promotionPhase(promotion, now) === 'LIVE').length;

  return (
    <section>
      <div className="section-head">
        <div>
          <h2>Promotions</h2>
          <p className="muted">
            {promotions.length} promotions · {live} live on the customer Home. A promotion opens a
            shop or filters the shops shown; it changes no price. A lower order is shown first.
          </p>
        </div>
        <button
          type="button"
          className="button primary"
          onClick={() => {
            setEditor({ mode: 'create' });
          }}
        >
          New promotion
        </button>
      </div>

      {actionError !== null && (
        <p className="error" role="alert">
          {actionError}
        </p>
      )}

      {rows.length === 0 ? (
        <p className="empty">No promotions yet.</p>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Promotion</th>
                <th scope="col">Placement</th>
                <th scope="col">Target</th>
                <th scope="col" className="num">
                  Order
                </th>
                <th scope="col">Status</th>
                <th scope="col">
                  <span className="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((promotion) => {
                const phase = promotionPhase(promotion, now);
                return (
                  <tr key={promotion.id}>
                    <td>
                      {promotion.image_url !== null && (
                        <img className="thumb promo-thumb" src={promotion.image_url} alt="" />
                      )}
                      <strong>{promotion.title ?? 'Artwork only'}</strong>{' '}
                      {promotion.is_sponsored && <span className="badge promo-ad">Ad</span>}
                      {promotion.subtitle !== null && (
                        <div className="muted small">{promotion.subtitle}</div>
                      )}
                    </td>
                    <td>{PROMOTION_PLACEMENT_LABELS[promotion.placement]}</td>
                    <td className="target-cell">{targetLabel(promotion)}</td>
                    <td className="num">{promotion.display_order}</td>
                    <td>
                      <span className={`badge promo-${phase.toLowerCase()}`}>
                        {PROMOTION_PHASE_LABELS[phase]}
                      </span>
                      {(promotion.starts_at !== null || promotion.ends_at !== null) && (
                        <div className="muted small">
                          {promotion.starts_at === null ? 'Now' : nepalDay(promotion.starts_at)} to{' '}
                          {promotion.ends_at === null
                            ? 'switched off'
                            : nepalDay(promotion.ends_at)}
                        </div>
                      )}
                    </td>
                    <td>
                      <div className="confirm">
                        {phase !== 'ENDED' && (
                          <button
                            type="button"
                            className="button"
                            disabled={busy}
                            onClick={() => {
                              setVisible.mutate({ promotion, isActive: !promotion.is_active });
                            }}
                          >
                            {promotion.is_active ? 'Hide' : 'Show'}
                          </button>
                        )}
                        <button
                          type="button"
                          className="button"
                          onClick={() => {
                            setEditor({ mode: 'edit', promotion });
                          }}
                        >
                          Edit
                        </button>
                        {deleting === promotion.id ? (
                          <>
                            <button
                              type="button"
                              className="button danger"
                              disabled={busy}
                              onClick={() => {
                                remove.mutate(promotion.id);
                              }}
                            >
                              Confirm delete
                            </button>
                            <button
                              type="button"
                              className="button ghost"
                              onClick={() => {
                                setDeleting(null);
                              }}
                            >
                              Cancel
                            </button>
                          </>
                        ) : (
                          <button
                            type="button"
                            className="button danger-outline"
                            disabled={busy}
                            onClick={() => {
                              setDeleting(promotion.id);
                            }}
                          >
                            Delete
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {editor !== null && (
        <PromotionModal
          // A fresh form per target, so one promotion's values never leak into the next.
          key={editor.mode === 'edit' ? editor.promotion.id : 'new'}
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

function PromotionModal({
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
  const editing = editor.mode === 'edit' ? editor.promotion : null;
  const [values, setValues] = useState<PromotionFormValues>(() =>
    editing === null ? emptyPromotionForm() : formFromPromotion(editing),
  );
  const [fieldErrors, setFieldErrors] = useState<
    Readonly<Partial<Record<PromotionFormField, string>>>
  >({});
  const [formError, setFormError] = useState<string | null>(null);

  const api = useAdminApi();
  const queryClient = useQueryClient();
  // Every image uploaded while this form is open. One the form does not end up saving is deleted
  // from the bucket when it closes; the server refuses to delete one a promotion uses.
  const uploaded = useRef<string[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const releaseUnused = (savedUrl: string | null) => {
    for (const url of unusedUploads(uploaded.current, savedUrl)) {
      // Best effort: a failure leaves an unused object in the bucket, nothing on screen.
      api.discardPromotionImage(url).catch(() => undefined);
    }
    uploaded.current = [];
  };
  const close = () => {
    releaseUnused(null);
    onClose();
  };

  const upload = useMutation({
    mutationFn: (file: File) => api.uploadPromotionImage(file),
    onMutate: () => {
      setUploadError(null);
    },
    onSuccess: ({ url }) => {
      uploaded.current.push(url);
      setValues((current) => ({ ...current, imageUrl: url }));
      setFieldErrors(({ imageUrl: _cleared, ...rest }) => rest);
    },
    onError: (error) => {
      setUploadError(promotionImageUploadError(error));
    },
    onSettled: () => {
      // The same file can be chosen again after a failure.
      if (fileInput.current !== null) fileInput.current.value = '';
    },
  });
  const chooseImage = (file: File | undefined) => {
    if (file === undefined || upload.isPending) return;
    const problem = promotionImageProblem(file);
    if (problem !== null) {
      setUploadError(problem);
      if (fileInput.current !== null) fileInput.current.value = '';
      return;
    }
    upload.mutate(file);
  };

  const save = useMutation({
    mutationFn: (request: PromotionWrite) =>
      editing === null ? api.createPromotion(request) : api.updatePromotion(editing.id, request),
    onSuccess: ({ promotion }) => {
      releaseUnused(promotion.image_url);
      onSaved();
    },
    onError: (error) => {
      const refusal = promotionSaveError(error, values.targetType);
      if (refusal.field === null) setFormError(refusal.message);
      else setFieldErrors({ [refusal.field]: refusal.message });
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: PROMOTIONS_KEY }),
  });

  // A native modal dialog: focus is trapped inside it and Escape closes it.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog !== null && !dialog.open) dialog.showModal();
  }, []);

  const change = (patch: Partial<PromotionFormValues>) => {
    setValues((current) => ({ ...current, ...patch }));
  };

  const submit = (event: SyntheticEvent) => {
    event.preventDefault();
    // Not while an image is on its way: the promotion would be saved without it.
    if (save.isPending || upload.isPending) return;
    setFormError(null);
    const result = validatePromotionForm(values);
    if (!result.ok) {
      setFieldErrors(result.errors);
      return;
    }
    setFieldErrors({});
    save.mutate(result.request);
  };

  const field = (name: PromotionFormField | 'placement' | 'targetType') => `${formId}-${name}`;
  const errorOf = (name: PromotionFormField) =>
    fieldErrors[name] === undefined ? null : (
      <span className="error small" role="alert">
        {fieldErrors[name]}
      </span>
    );
  const target = values.targetType === '' ? null : TARGET_FIELD[values.targetType];
  const carousel = values.placement === 'CAROUSEL';

  return (
    <dialog
      ref={dialogRef}
      className="modal modal-wide"
      aria-labelledby={`${formId}-title-heading`}
      onClose={close}
    >
      <form onSubmit={submit} noValidate>
        <h2 id={`${formId}-title-heading`}>
          {editing === null ? 'New promotion' : `Edit ${editing.title ?? 'promotion'}`}
        </h2>

        <div className="field-pair">
          <div>
            <label htmlFor={field('placement')}>Placement</label>
            <select
              id={field('placement')}
              value={values.placement}
              onChange={(event) => {
                const placement = promotionPlacements.find(
                  (candidate) => candidate === event.target.value,
                );
                if (placement !== undefined) change({ placement });
              }}
            >
              {promotionPlacements.map((placement) => (
                <option key={placement} value={placement}>
                  {PROMOTION_PLACEMENT_LABELS[placement]}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor={field('displayOrder')}>Sort order</label>
            <input
              id={field('displayOrder')}
              inputMode="numeric"
              value={values.displayOrder}
              onChange={(event) => {
                change({ displayOrder: event.target.value });
              }}
            />
            {errorOf('displayOrder')}
          </div>
        </div>

        <label htmlFor={field('title')}>{carousel ? 'Title (optional)' : 'Title'}</label>
        <input
          id={field('title')}
          value={values.title}
          maxLength={60}
          placeholder="Dashain Mega Sale"
          autoFocus
          onChange={(event) => {
            change({ title: event.target.value });
          }}
        />
        {errorOf('title')}

        <label htmlFor={field('subtitle')}>Subtitle (optional)</label>
        <input
          id={field('subtitle')}
          value={values.subtitle}
          maxLength={80}
          onChange={(event) => {
            change({ subtitle: event.target.value });
          }}
        />
        {errorOf('subtitle')}

        <fieldset className="photos" aria-busy={upload.isPending}>
          <legend>{carousel ? 'Image' : 'Image (optional)'}</legend>
          {values.imageUrl !== '' && (
            <div className="promo-preview">
              <img src={values.imageUrl} alt="The promotion’s image" />
              <button
                type="button"
                className="button ghost"
                disabled={upload.isPending}
                onClick={() => {
                  change({ imageUrl: '' });
                }}
              >
                Remove image
              </button>
            </div>
          )}
          <label htmlFor={field('imageUrl')} className="visually-hidden">
            {values.imageUrl === '' ? 'Choose an image' : 'Choose another image'}
          </label>
          <input
            ref={fileInput}
            id={field('imageUrl')}
            type="file"
            accept={PROMOTION_IMAGE_ACCEPT}
            disabled={upload.isPending}
            onChange={(event) => {
              chooseImage(event.target.files?.[0]);
            }}
          />
          {upload.isPending ? (
            <span className="uploading" role="status">
              <span className="spinner" aria-hidden="true" /> Uploading…
            </span>
          ) : (
            <span className="muted small">
              JPEG, PNG or WebP, at most 5 MB. It is stored as WebP, at most 1200 px wide.
            </span>
          )}
          {uploadError !== null && (
            <span className="error small" role="alert">
              {uploadError}
            </span>
          )}
        </fieldset>
        {errorOf('imageUrl')}

        <div className="field-pair">
          <div>
            <label htmlFor={field('targetType')}>Target type</label>
            <select
              id={field('targetType')}
              value={values.targetType}
              onChange={(event) => {
                const targetType =
                  promotionTargetTypes.find((candidate) => candidate === event.target.value) ?? '';
                setValues((current) => withTargetType(current, targetType));
              }}
            >
              {promotionTargetTypes.map((type) => (
                <option key={type} value={type}>
                  {PROMOTION_TARGET_LABELS[type]}
                </option>
              ))}
              <option value="">None (not tappable)</option>
            </select>
          </div>
          {target !== null && (
            <div>
              <label htmlFor={field('targetValue')}>{target.label}</label>
              <input
                id={field('targetValue')}
                className="mono"
                value={values.targetValue}
                placeholder={target.placeholder}
                onChange={(event) => {
                  change({ targetValue: event.target.value });
                }}
              />
            </div>
          )}
        </div>
        {target !== null && <span className="muted small">{target.hint}</span>}
        {errorOf('targetValue')}

        <div className="field-pair">
          <div>
            <label htmlFor={field('startsOn')}>First day (optional, Nepal Time)</label>
            <input
              id={field('startsOn')}
              type="date"
              value={values.startsOn}
              onChange={(event) => {
                change({ startsOn: event.target.value });
              }}
            />
            {errorOf('startsOn')}
          </div>
          <div>
            <label htmlFor={field('endsOn')}>Last day (optional, Nepal Time)</label>
            <input
              id={field('endsOn')}
              type="date"
              value={values.endsOn}
              onChange={(event) => {
                change({ endsOn: event.target.value });
              }}
            />
            {errorOf('endsOn')}
          </div>
        </div>

        {SPONSORSHIP_AVAILABLE ? (
          <>
            <label htmlFor={field('adPurchaseId')}>
              Ad purchase ID (sponsored promotions only)
            </label>
            <input
              id={field('adPurchaseId')}
              className="mono"
              value={values.adPurchaseId}
              onChange={(event) => {
                change({ adPurchaseId: event.target.value });
              }}
            />
            {errorOf('adPurchaseId')}
            <p className="guardrail">
              Leave it empty for an ordinary promotion. A promotion carries the “Ad” badge only with
              the purchase a vendor made in the Ad Marketplace. It must then be a carousel banner
              that targets that vendor’s shop, with its first and last day inside the period the
              vendor paid for.
            </p>
          </>
        ) : (
          <p className="guardrail">
            Sponsored promotions are not available yet. A promotion carries the “Ad” badge only with
            the purchase a vendor made in the Ad Marketplace, and no vendor can buy an ad yet. Every
            promotion saved here is an ordinary one.
          </p>
        )}

        <label className="check">
          <input
            type="checkbox"
            checked={values.isActive}
            onChange={(event) => {
              change({ isActive: event.target.checked });
            }}
          />
          Active (shown on the customer Home inside its dates)
        </label>

        {formError !== null && (
          <p className="error" role="alert">
            {formError}
          </p>
        )}

        <div className="modal-actions">
          <button type="button" className="button ghost" onClick={close}>
            Cancel
          </button>
          <button
            type="submit"
            className="button primary"
            disabled={save.isPending || upload.isPending}
          >
            {save.isPending ? 'Saving…' : editing === null ? 'Create' : 'Save'}
          </button>
        </div>
      </form>
    </dialog>
  );
}
