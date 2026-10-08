import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState, type SyntheticEvent } from 'react';

import { ApiError } from '../../api/client';
import { useAdminApi } from '../../app-context';
import {
  defaultToggle,
  emptyPlanForm,
  formFromPlan,
  offeredToggle,
  PLAN_MODEL_LABELS,
  planModels,
  planRows,
  planSaveError,
  planTermsLabel,
  TERMS_FIELD_LABELS,
  validateNewPlan,
  validatePlanEdit,
  withModel,
  type PlanFormField,
  type PlanFormValues,
  type PricingPlanView,
} from './pricing-rules';

const PLANS_KEY = ['admin', 'pricing-plans'] as const;

/** What the modal is doing: creating a plan or editing one. */
type Editor =
  { readonly mode: 'create' } | { readonly mode: 'edit'; readonly plan: PricingPlanView };

/**
 * Pricing plans (SPEC Vendor Pricing, "Onboarding Models"): the Free, Subscription and Commission
 * plans vendors may choose. One offered Commission plan is the default a vendor falls back to. A
 * plan's model and terms are fixed once created; a vendor's own change of plan is queued for its
 * Billing Cycle renewal and is never made from here. Reads and writes /api/admin/pricing-plans.
 */
export function PricingPlanScreen() {
  const api = useAdminApi();
  const [editor, setEditor] = useState<Editor | null>(null);
  const query = useQuery({ queryKey: PLANS_KEY, queryFn: () => api.listPricingPlans() });

  if (query.isPending) return <p className="muted">Loading…</p>;
  if (query.isError) {
    return (
      <p className="error" role="alert">
        {query.error instanceof ApiError && query.error.code === 'NETWORK_ERROR'
          ? 'The API cannot be reached.'
          : 'The pricing plans could not be loaded.'}{' '}
        <button type="button" className="link" onClick={() => void query.refetch()}>
          Try again
        </button>
      </p>
    );
  }

  const { plans } = query.data;
  const rows = planRows(plans);
  const offered = plans.filter((plan) => plan.is_offered).length;
  const fallback = plans.find((plan) => plan.is_default);

  return (
    <section>
      <div className="section-head">
        <div>
          <h2>Pricing plans</h2>
          <p className="muted">
            {plans.length} plans · {offered} on offer · default:{' '}
            {fallback === undefined ? 'none' : fallback.name}. A vendor can select only a plan that
            is on offer, and its change takes effect at its next Billing Cycle renewal. A plan’s
            model and terms never change: publish a new plan and withdraw the old one.
          </p>
        </div>
        <button
          type="button"
          className="button primary"
          onClick={() => {
            setEditor({ mode: 'create' });
          }}
        >
          New plan
        </button>
      </div>

      {rows.length === 0 ? (
        <p className="empty">No pricing plans yet.</p>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Plan</th>
                <th scope="col">Model</th>
                <th scope="col">Terms</th>
                <th scope="col" className="num">
                  Vendors
                </th>
                <th scope="col">Status</th>
                <th scope="col">
                  <span className="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((plan) => (
                <tr key={plan.id}>
                  <td>
                    <strong>{plan.name}</strong>
                  </td>
                  <td>{PLAN_MODEL_LABELS[plan.model]}</td>
                  <td>{planTermsLabel(plan)}</td>
                  <td className="num">{plan.vendor_count}</td>
                  <td>
                    <span
                      className={`badge ${plan.is_offered ? 'plan-offered' : 'plan-withdrawn'}`}
                    >
                      {plan.is_offered ? 'On offer' : 'Withdrawn'}
                    </span>{' '}
                    {plan.is_default && <span className="badge plan-default">Default</span>}
                  </td>
                  <td>
                    <button
                      type="button"
                      className="button"
                      onClick={() => {
                        setEditor({ mode: 'edit', plan });
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
        <PlanModal
          // A fresh form per target, so one plan's values never leak into the next.
          key={editor.mode === 'edit' ? editor.plan.id : 'new'}
          editor={editor}
          plans={plans}
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

function PlanModal({
  editor,
  plans,
  onSaved,
  onClose,
}: {
  readonly editor: Editor;
  readonly plans: readonly PricingPlanView[];
  readonly onSaved: () => void;
  readonly onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const formId = useId();
  const editing = editor.mode === 'edit' ? editor.plan : null;
  const [values, setValues] = useState<PlanFormValues>(() =>
    editing === null ? emptyPlanForm() : formFromPlan(editing),
  );
  const [fieldErrors, setFieldErrors] = useState<Readonly<Partial<Record<PlanFormField, string>>>>(
    {},
  );
  const [formError, setFormError] = useState<string | null>(null);

  const api = useAdminApi();
  const queryClient = useQueryClient();
  const save = useMutation({
    // The create and the edit send different bodies; each call site hands over its own request.
    mutationFn: (send: () => Promise<unknown>) => send(),
    onSuccess: onSaved,
    onError: (error) => {
      const refusal = planSaveError(error, editor.mode);
      if (refusal.field === null) setFormError(refusal.message);
      else setFieldErrors({ [refusal.field]: refusal.message });
    },
    // A save can move the default from another plan, and a refusal means the list is stale.
    onSettled: () => queryClient.invalidateQueries({ queryKey: PLANS_KEY }),
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
      const result = validateNewPlan(values, plans);
      if (!result.ok) {
        setFieldErrors(result.errors);
        return;
      }
      setFieldErrors({});
      save.mutate(() => api.createPricingPlan(result.request));
      return;
    }
    const result = validatePlanEdit(values, editing, plans);
    if (!result.ok) {
      setFieldErrors(result.errors);
      return;
    }
    setFieldErrors({});
    save.mutate(() => api.updatePricingPlan(editing.id, result.request));
  };

  const field = (name: PlanFormField | 'model') => `${formId}-${name}`;
  const errorOf = (name: PlanFormField) =>
    fieldErrors[name] === undefined ? null : (
      <span className="error small" role="alert">
        {fieldErrors[name]}
      </span>
    );
  const asDefault = defaultToggle(values, editing, plans);
  const onOffer = offeredToggle(editing);

  return (
    <dialog ref={dialogRef} className="modal" aria-labelledby={`${formId}-title`} onClose={onClose}>
      <form onSubmit={submit} noValidate>
        <h2 id={`${formId}-title`}>{editing === null ? 'New plan' : `Edit ${editing.name}`}</h2>

        <label htmlFor={field('name')}>Plan name</label>
        <input
          id={field('name')}
          value={values.name}
          maxLength={80}
          placeholder="Basic Commission"
          autoFocus
          onChange={(event) => {
            setValues((current) => ({ ...current, name: event.target.value }));
          }}
        />
        {errorOf('name')}

        <label htmlFor={field('model')}>Pricing model</label>
        <select
          id={field('model')}
          value={values.model}
          disabled={editing !== null}
          onChange={(event) => {
            const model = planModels.find((candidate) => candidate === event.target.value);
            if (model !== undefined) setValues((current) => withModel(current, model));
          }}
        >
          {planModels.map((model) => (
            <option key={model} value={model}>
              {PLAN_MODEL_LABELS[model]}
            </option>
          ))}
        </select>

        <label htmlFor={field('terms')}>{TERMS_FIELD_LABELS[values.model]}</label>
        <input
          id={field('terms')}
          inputMode="decimal"
          value={values.terms}
          disabled={editing !== null}
          onChange={(event) => {
            setValues((current) => ({ ...current, terms: event.target.value }));
          }}
        />
        {errorOf('terms')}
        {editing !== null && (
          <span className="muted small">
            The model and terms of an existing plan are locked: vendors and their orders are
            accounted under them. To change a rate, publish a new plan and withdraw this one.
          </span>
        )}

        <label className="check">
          <input
            type="checkbox"
            checked={values.isOffered}
            disabled={!onOffer.enabled}
            onChange={(event) => {
              setValues((current) => ({
                ...current,
                isOffered: event.target.checked,
                isDefault: event.target.checked && current.isDefault,
              }));
            }}
          />
          On offer (vendors may select it)
        </label>
        {onOffer.note !== null && <span className="muted small">{onOffer.note}</span>}
        {errorOf('isOffered')}

        <label className="check">
          <input
            type="checkbox"
            checked={values.isDefault}
            disabled={!asDefault.enabled}
            onChange={(event) => {
              setValues((current) => ({ ...current, isDefault: event.target.checked }));
            }}
          />
          Default plan (the fallback Commission plan)
        </label>
        {asDefault.note !== null && <span className="muted small">{asDefault.note}</span>}
        {errorOf('isDefault')}

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
