import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState, type SyntheticEvent } from 'react';

import { ApiError } from '../../api/client';
import { useAdminApi } from '../../app-context';
import { formatDateTime, formatNpr } from '../../lib/format';
import {
  CAMPAIGN_PHASE_LABELS,
  campaignPhase,
  campaignSaveErrorMessage,
  discountLabel,
  emptyCampaignForm,
  formFromCampaign,
  fundingLabel,
  publishRequest,
  termsChangeWarning,
  validateCampaignForm,
  type AdminCampaignView,
  type CampaignFormField,
  type CampaignFormValues,
  type CampaignWrite,
} from './campaign-rules';

const CAMPAIGNS_KEY = ['admin', 'campaigns'] as const;

/** What the modal is doing: creating a campaign or editing one. */
type Editor =
  { readonly mode: 'create' } | { readonly mode: 'edit'; readonly campaign: AdminCampaignView };

/**
 * Platform campaigns (SPEC core section 7): a Super Admin writes the discount rule and the share
 * the vendor bears, and publishes it. Publishing only invites: a campaign applies to a shop when
 * that shop's own account opts in from the Vendor App. This screen has no control that enrols a
 * shop, and must never get one.
 *
 * Reads and writes /api/admin/campaigns. The server alone sets `terms_version`: after every write
 * the list is refetched, so a raised version and its emptied opt-in count are the server's.
 */
export function CampaignScreen() {
  const api = useAdminApi();
  const queryClient = useQueryClient();
  const [editor, setEditor] = useState<Editor | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const query = useQuery({ queryKey: CAMPAIGNS_KEY, queryFn: () => api.listCampaigns() });

  // Publish / Unpublish from a card: the same terms with `is_active` flipped, so no opt-in is voided.
  const publish = useMutation({
    mutationFn: ({ campaign, isActive }: { campaign: AdminCampaignView; isActive: boolean }) =>
      api.updateCampaign(campaign.id, publishRequest(campaign, isActive)),
    onMutate: () => {
      setActionError(null);
    },
    onError: (error) => {
      setActionError(campaignSaveErrorMessage(error));
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: CAMPAIGNS_KEY }),
  });

  if (query.isPending) return <p className="muted">Loading…</p>;
  if (query.isError) {
    return (
      <p className="error" role="alert">
        {query.error instanceof ApiError && query.error.code === 'NETWORK_ERROR'
          ? 'The API cannot be reached.'
          : 'The campaigns could not be loaded.'}{' '}
        <button type="button" className="link" onClick={() => void query.refetch()}>
          Try again
        </button>
      </p>
    );
  }

  const { campaigns } = query.data;

  const now = new Date().toISOString();
  const published = campaigns.filter((campaign) => {
    const phase = campaignPhase(campaign, now);
    return phase === 'OPEN' || phase === 'SCHEDULED';
  }).length;

  return (
    <section>
      <div className="section-head">
        <div>
          <h2>Campaigns</h2>
          <p className="muted">
            {campaigns.length} campaigns · {published} published. Publishing a campaign invites
            shops; it enrols none. Each shop opts in itself from the Vendor App, to the terms as
            shown, and can opt out at any time.
          </p>
        </div>
        <button
          type="button"
          className="button primary"
          onClick={() => {
            setEditor({ mode: 'create' });
          }}
        >
          New campaign
        </button>
      </div>

      {actionError !== null && (
        <p className="error" role="alert">
          {actionError}
        </p>
      )}

      {campaigns.length === 0 ? (
        <p className="empty">No campaigns yet.</p>
      ) : (
        <ul className="cards" aria-label="Campaigns">
          {campaigns.map((campaign) => (
            <CampaignCard
              key={campaign.id}
              campaign={campaign}
              now={now}
              busy={publish.isPending}
              onEdit={() => {
                setEditor({ mode: 'edit', campaign });
              }}
              onPublish={(isActive) => {
                publish.mutate({ campaign, isActive });
              }}
            />
          ))}
        </ul>
      )}

      {editor !== null && (
        <CampaignModal
          // A fresh form per target, so one campaign's values never leak into the next.
          key={editor.mode === 'edit' ? editor.campaign.id : 'new'}
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

function CampaignCard({
  campaign,
  now,
  busy,
  onEdit,
  onPublish,
}: {
  readonly campaign: AdminCampaignView;
  readonly now: string;
  /** A publish or unpublish is in flight. */
  readonly busy: boolean;
  readonly onEdit: () => void;
  readonly onPublish: (isActive: boolean) => void;
}) {
  const phase = campaignPhase(campaign, now);
  const optIns = campaign.opt_in_count;

  return (
    <li className="card">
      <div className="card-head">
        <div className="card-title">
          <strong>{campaign.name}</strong>
          <span className={`badge campaign-${phase.toLowerCase()}`}>
            {CAMPAIGN_PHASE_LABELS[phase]}
          </span>
          <span className="badge">Terms v{campaign.terms_version}</span>
        </div>
        <div className="confirm">
          {phase !== 'ENDED' && (
            <button
              type="button"
              className="button"
              disabled={busy}
              onClick={() => {
                onPublish(!campaign.is_active);
              }}
            >
              {campaign.is_active ? 'Unpublish' : 'Publish to vendors'}
            </button>
          )}
          <button type="button" className="button" onClick={onEdit}>
            Edit
          </button>
        </div>
      </div>

      <dl className="facts">
        <div>
          <dt>Discount</dt>
          <dd>{discountLabel(campaign)}</dd>
        </div>
        <div>
          <dt>Minimum cart</dt>
          <dd>{campaign.min_cart_npr === 0 ? 'None' : formatNpr(campaign.min_cart_npr)}</dd>
        </div>
        <div>
          <dt>Funding</dt>
          <dd>{fundingLabel(campaign.vendor_share_percent)}</dd>
        </div>
        <div>
          <dt>Runs (Nepal Time)</dt>
          <dd>
            {formatDateTime(campaign.starts_at).slice(0, 10)} to{' '}
            {formatDateTime(campaign.ends_at).slice(0, 10)}
          </dd>
        </div>
        <div>
          <dt>Opted in (by the shops themselves)</dt>
          <dd>
            {optIns} shop{optIns === 1 ? '' : 's'} on terms v{campaign.terms_version}
          </dd>
        </div>
      </dl>
    </li>
  );
}

function CampaignModal({
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
  const editing = editor.mode === 'edit' ? editor.campaign : null;
  const [values, setValues] = useState<CampaignFormValues>(() =>
    editing === null ? emptyCampaignForm() : formFromCampaign(editing),
  );
  const [fieldErrors, setFieldErrors] = useState<
    Readonly<Partial<Record<CampaignFormField, string>>>
  >({});
  // The terms warning the admin has been shown; saving needs a second press on the same values.
  const [warned, setWarned] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const api = useAdminApi();
  const queryClient = useQueryClient();
  const save = useMutation({
    mutationFn: (request: CampaignWrite) =>
      editing === null ? api.createCampaign(request) : api.updateCampaign(editing.id, request),
    // The window closes only once the list is the server's again: a PUT that changed a term
    // raised the version and voided the opt-ins there, and the card must show both.
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: CAMPAIGNS_KEY });
      onSaved();
    },
    onError: (error) => {
      setFormError(campaignSaveErrorMessage(error));
      void queryClient.invalidateQueries({ queryKey: CAMPAIGNS_KEY });
    },
  });

  // A native modal dialog: focus is trapped inside it and Escape closes it.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog !== null && !dialog.open) dialog.showModal();
  }, []);

  const change = (patch: Partial<CampaignFormValues>) => {
    setValues((current) => ({ ...current, ...patch }));
    setWarned(null);
  };

  const submit = (event: SyntheticEvent) => {
    event.preventDefault();
    if (save.isPending) return;
    setFormError(null);
    const result = validateCampaignForm(values);
    if (!result.ok) {
      setFieldErrors(result.errors);
      return;
    }
    setFieldErrors({});
    const warning = editing === null ? null : termsChangeWarning(editing, result.request);
    if (warning !== null && warned !== warning) {
      setWarned(warning);
      return;
    }
    save.mutate(result.request);
  };

  const field = (name: CampaignFormField) => `${formId}-${name}`;
  const errorOf = (name: CampaignFormField) =>
    fieldErrors[name] === undefined ? null : (
      <span className="error small" role="alert">
        {fieldErrors[name]}
      </span>
    );
  const percentage = values.kind === 'PERCENTAGE';

  return (
    <dialog
      ref={dialogRef}
      className="modal modal-wide"
      aria-labelledby={`${formId}-title`}
      onClose={onClose}
    >
      <form onSubmit={submit} noValidate>
        <h2 id={`${formId}-title`}>{editing === null ? 'New campaign' : `Edit ${editing.name}`}</h2>
        <p className="muted small">
          Terms version {editing === null ? '1 (set by the server)' : String(editing.terms_version)}
          . The version is raised automatically when the discount, cap, minimum cart, vendor share
          or either date changes.
        </p>

        <label htmlFor={field('name')}>Name</label>
        <input
          id={field('name')}
          value={values.name}
          maxLength={80}
          autoFocus
          onChange={(event) => {
            change({ name: event.target.value });
          }}
        />
        {errorOf('name')}

        <fieldset className="choice">
          <legend>Discount type</legend>
          <label className="check">
            <input
              type="radio"
              name={`${formId}-kind`}
              checked={percentage}
              onChange={() => {
                change({ kind: 'PERCENTAGE' });
              }}
            />
            Percentage
          </label>
          <label className="check">
            <input
              type="radio"
              name={`${formId}-kind`}
              checked={!percentage}
              onChange={() => {
                change({ kind: 'FLAT' });
              }}
            />
            Flat amount
          </label>
        </fieldset>

        <div className="field-pair">
          <div>
            <label htmlFor={field('value')}>{percentage ? 'Discount (%)' : 'Discount (NPR)'}</label>
            <input
              id={field('value')}
              inputMode="decimal"
              value={values.value}
              onChange={(event) => {
                change({ value: event.target.value });
              }}
            />
            {errorOf('value')}
          </div>
          {percentage && (
            <div>
              <label htmlFor={field('maxDiscount')}>Cap per order (NPR, optional)</label>
              <input
                id={field('maxDiscount')}
                inputMode="decimal"
                value={values.maxDiscount}
                onChange={(event) => {
                  change({ maxDiscount: event.target.value });
                }}
              />
              {errorOf('maxDiscount')}
            </div>
          )}
        </div>

        <div className="field-pair">
          <div>
            <label htmlFor={field('minCart')}>Minimum cart (NPR)</label>
            <input
              id={field('minCart')}
              inputMode="decimal"
              value={values.minCart}
              onChange={(event) => {
                change({ minCart: event.target.value });
              }}
            />
            {errorOf('minCart')}
          </div>
          <div>
            <label htmlFor={field('vendorSharePercent')}>Vendor share (%)</label>
            <input
              id={field('vendorSharePercent')}
              inputMode="decimal"
              value={values.vendorSharePercent}
              onChange={(event) => {
                change({ vendorSharePercent: event.target.value });
              }}
            />
            {errorOf('vendorSharePercent')}
          </div>
        </div>
        <p className="muted small">
          The vendor share is the part of each discount taken from the shop’s payout; the platform
          funds the rest. Each shop sees this figure before it opts in.
        </p>

        <div className="field-pair">
          <div>
            <label htmlFor={field('startsOn')}>First day (Nepal Time)</label>
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
            <label htmlFor={field('endsOn')}>Last day (Nepal Time)</label>
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

        <label className="check">
          <input
            type="checkbox"
            checked={values.isActive}
            onChange={(event) => {
              change({ isActive: event.target.checked });
            }}
          />
          Published (shops see the invite and may opt in)
        </label>

        <p className="guardrail">
          You cannot opt a shop in. This form has no shop list on purpose: a campaign discounts a
          shop’s orders only after that shop’s own account accepts these terms in the Vendor App.
        </p>

        {warned !== null && (
          <p className="warning" role="alert">
            {warned}
          </p>
        )}

        {formError !== null && (
          <p className="error" role="alert">
            {formError}
          </p>
        )}

        <div className="modal-actions">
          <button type="button" className="button ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            className={`button ${warned === null ? 'primary' : 'danger'}`}
            disabled={save.isPending}
          >
            {save.isPending
              ? 'Saving…'
              : warned !== null
                ? 'Save and raise the terms version'
                : editing === null
                  ? 'Create'
                  : 'Save'}
          </button>
        </div>
      </form>
    </dialog>
  );
}
