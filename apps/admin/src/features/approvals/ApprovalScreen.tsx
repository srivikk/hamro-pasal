import type { AdminModelChangeRequestListResponseBody } from '@hamro-pasal/shared-types';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';

import { ApiError } from '../../api/client';
import { useAdminApi } from '../../app-context';
import { formatDateTime } from '../../lib/format';
import {
  approveButton,
  decisionErrorMessage,
  MODEL_CHANGE_FILTERS,
  modelChangeRows,
  replaceModelChangeRequest,
  SETTLEMENT_MODEL_LABELS,
  validateDecision,
  type ModelChangeRequestView,
} from './approval-rules';

const REQUESTS_KEY = ['admin', 'model-requests'] as const;

/** One decision as sent: `reason` is a rejection's, null for an approval. */
interface Decision {
  readonly id: string;
  readonly decision: 'APPROVE' | 'REJECT';
  readonly reason: string | null;
}

/** The row that is asking for a second press, and for which decision. */
interface Confirming {
  readonly id: string;
  readonly decision: 'APPROVE' | 'REJECT';
}

/**
 * Vendor requests (SPEC Super Admin flow step 6): the settlement model changes vendors asked for
 * from the Vendor App, to approve or reject. An admin decides a request as asked; this screen
 * cannot start a change or choose a model for a shop.
 *
 * Reads GET /api/admin/settlement-model-requests, whose rows carry the guardrails (open orders,
 * ledger balance, running ads): Approve is disabled, with the reason, while any stands. The
 * server checks them again under the vendor row lock.
 */
export function ApprovalScreen() {
  const api = useAdminApi();
  const queryClient = useQueryClient();
  const [pending, setPending] = useState(true);
  const [confirming, setConfirming] = useState<Confirming | null>(null);
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});

  const query = useQuery({ queryKey: REQUESTS_KEY, queryFn: () => api.listModelChangeRequests() });

  const send = useMutation({
    mutationFn: ({ id, decision, reason: why }: Decision) =>
      decision === 'APPROVE'
        ? api.approveModelChangeRequest(id)
        : api.rejectModelChangeRequest(id, why),
    onMutate: ({ id }) => {
      setConfirming(null);
      setReason('');
      setErrors(({ [id]: _cleared, ...rest }) => rest);
    },
    onSuccess: (body) => {
      // Show the outcome at once; the refetch below confirms it.
      queryClient.setQueryData<AdminModelChangeRequestListResponseBody>(REQUESTS_KEY, (current) =>
        current === undefined ? current : replaceModelChangeRequest(current, body.request),
      );
    },
    onError: (error, { id }) => {
      setErrors((current) => ({ ...current, [id]: decisionErrorMessage(error) }));
    },
    // A refusal means the guardrails moved: the refetch brings the row's new counts.
    onSettled: () => queryClient.invalidateQueries({ queryKey: REQUESTS_KEY }),
  });

  if (query.isPending) return <p className="muted">Loading…</p>;
  if (query.isError) {
    return (
      <p className="error" role="alert">
        {query.error instanceof ApiError && query.error.code === 'NETWORK_ERROR'
          ? 'The API cannot be reached.'
          : 'The vendor requests could not be loaded.'}{' '}
        <button type="button" className="link" onClick={() => void query.refetch()}>
          Try again
        </button>
      </p>
    );
  }

  const { requests } = query.data;
  const rows = modelChangeRows(requests, pending);
  const waiting = modelChangeRows(requests, true).length;

  const decide = (request: ModelChangeRequestView, decision: 'APPROVE' | 'REJECT') => {
    if (send.isPending) return;
    const result = validateDecision(request, decision, reason);
    if (!result.ok) {
      setErrors((current) => ({ ...current, [request.id]: result.error }));
      return;
    }
    send.mutate({ id: request.id, decision, reason: result.reason });
  };

  return (
    <section>
      <div className="section-head">
        <div>
          <h2>Vendor requests</h2>
          <p className="muted">
            {waiting} settlement model change{waiting === 1 ? '' : 's'} waiting. A change takes
            effect only when the shop has no open order, no ad running and a ledger at 0 or above.
            Model C cannot be selected before Phase 3.
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

      <div className="filters" role="group" aria-label="Request status">
        {MODEL_CHANGE_FILTERS.map((filter) => (
          <button
            key={filter.label}
            type="button"
            className="chip"
            aria-pressed={pending === filter.pending}
            onClick={() => {
              setPending(filter.pending);
              setConfirming(null);
            }}
          >
            {filter.label} ({modelChangeRows(requests, filter.pending).length})
          </button>
        ))}
      </div>

      {rows.length === 0 ? (
        <p className="empty">{pending ? 'No requests are waiting.' : 'No decided requests.'}</p>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Vendor</th>
                <th scope="col">Current model</th>
                <th scope="col">Requested model</th>
                <th scope="col">Requested</th>
                <th scope="col">{pending ? 'Decision' : 'Outcome'}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((request) => (
                <RequestRow
                  key={request.id}
                  request={request}
                  confirming={confirming?.id === request.id ? confirming.decision : null}
                  reason={reason}
                  busy={send.isPending}
                  saving={send.isPending && send.variables.id === request.id}
                  error={errors[request.id] ?? null}
                  onReason={setReason}
                  onAsk={(decision) => {
                    setConfirming({ id: request.id, decision });
                    setReason('');
                  }}
                  onCancel={() => {
                    setConfirming(null);
                  }}
                  onConfirm={(decision) => {
                    decide(request, decision);
                  }}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function RequestRow({
  request,
  confirming,
  reason,
  busy,
  saving,
  error,
  onReason,
  onAsk,
  onCancel,
  onConfirm,
}: {
  readonly request: ModelChangeRequestView;
  readonly confirming: 'APPROVE' | 'REJECT' | null;
  readonly reason: string;
  /** A decision is in flight (this row's or another's): no second one is started. */
  readonly busy: boolean;
  readonly saving: boolean;
  readonly error: string | null;
  readonly onReason: (reason: string) => void;
  readonly onAsk: (decision: 'APPROVE' | 'REJECT') => void;
  readonly onCancel: () => void;
  readonly onConfirm: (decision: 'APPROVE' | 'REJECT') => void;
}) {
  const reasonId = useId();
  const approve = approveButton(request);

  return (
    <tr>
      <td>
        <strong>{request.business_name}</strong>
        <div className="muted small">{request.phone}</div>
      </td>
      <td>{SETTLEMENT_MODEL_LABELS[request.current_model]}</td>
      <td>
        {SETTLEMENT_MODEL_LABELS[request.requested_model]}
        {request.status !== 'PENDING' && (
          <div className="muted small">
            Asked from {SETTLEMENT_MODEL_LABELS[request.from_model]}
          </div>
        )}
      </td>
      <td>{formatDateTime(request.requested_at)}</td>
      <td>
        {request.status !== 'PENDING' ? (
          <>
            <span className={`badge request-${request.status.toLowerCase()}`}>
              {request.status === 'APPROVED' ? 'Approved' : 'Rejected'}
            </span>
            <div className="muted small">
              {request.decided_at !== null && formatDateTime(request.decided_at)}
              {request.rejection_reason !== null && ` · ${request.rejection_reason}`}
            </div>
          </>
        ) : confirming === 'APPROVE' ? (
          <div className="confirm">
            <button
              type="button"
              className="button primary"
              disabled={!approve.enabled || busy}
              onClick={() => {
                onConfirm('APPROVE');
              }}
            >
              Confirm approve
            </button>
            <button type="button" className="button ghost" onClick={onCancel}>
              Cancel
            </button>
          </div>
        ) : confirming === 'REJECT' ? (
          <div className="decision">
            <label className="visually-hidden" htmlFor={reasonId}>
              Reason for the vendor (optional)
            </label>
            <input
              id={reasonId}
              className="search"
              placeholder="Reason for the vendor (optional)"
              maxLength={500}
              value={reason}
              autoFocus
              onChange={(event) => {
                onReason(event.target.value);
              }}
            />
            <div className="confirm">
              <button
                type="button"
                className="button danger"
                disabled={busy}
                onClick={() => {
                  onConfirm('REJECT');
                }}
              >
                Confirm reject
              </button>
              <button type="button" className="button ghost" onClick={onCancel}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="confirm">
            <button
              type="button"
              className="button primary"
              disabled={!approve.enabled || busy}
              onClick={() => {
                onAsk('APPROVE');
              }}
            >
              {saving ? 'Saving…' : 'Approve'}
            </button>
            <button
              type="button"
              className="button danger-outline"
              disabled={busy}
              onClick={() => {
                onAsk('REJECT');
              }}
            >
              Reject
            </button>
          </div>
        )}
        {request.status === 'PENDING' && approve.note !== null && (
          <div className="muted small note">{approve.note}</div>
        )}
        {error !== null && (
          <div className="error small" role="alert">
            {error}
          </div>
        )}
      </td>
    </tr>
  );
}
