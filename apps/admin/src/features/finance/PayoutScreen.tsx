import type {
  AdminPayoutListResponseBody,
  AdminPayoutView,
  PayoutStatus,
} from '@hamro-pasal/shared-types';
import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
  type InfiniteData,
} from '@tanstack/react-query';
import { useState } from 'react';

import { useAdminApi } from '../../app-context';
import { formatDateTime, formatNpr } from '../../lib/format';
import {
  parseBankReference,
  parseRejectionReason,
  PAYOUT_FILTERS,
  PAYOUT_STATUS_LABELS,
  payoutDecisionErrorMessage,
  replacePayout,
} from './payout-rules';

const PAYOUTS_KEY = ['admin', 'payouts'] as const;

type Decision =
  | { readonly id: string; readonly action: 'APPROVE'; readonly bankReference: string }
  | { readonly id: string; readonly action: 'REJECT'; readonly reason: string | null };

/**
 * Phase 22 payouts: vendors' requests to withdraw wallet money. The amount already left the wallet
 * when it was requested; Approve records the bank transfer that paid it, Reject returns it.
 */
export function PayoutScreen() {
  const api = useAdminApi();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<PayoutStatus | undefined>('PENDING');
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});

  const query = useInfiniteQuery({
    queryKey: [...PAYOUTS_KEY, status ?? 'ALL'],
    queryFn: ({ pageParam }) => api.listPayouts({ status, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.next_cursor ?? undefined,
  });

  const decide = useMutation({
    mutationFn: (decision: Decision) =>
      decision.action === 'APPROVE'
        ? api.approvePayout(decision.id, decision.bankReference)
        : api.rejectPayout(decision.id, decision.reason),
    onMutate: ({ id }) => {
      setErrors(({ [id]: _cleared, ...rest }) => rest);
    },
    onSuccess: ({ payout }) => {
      queryClient.setQueriesData<InfiniteData<AdminPayoutListResponseBody, string | undefined>>(
        { queryKey: PAYOUTS_KEY },
        (current) => replacePayout(current, payout),
      );
    },
    onError: (error, { id }) => {
      setErrors((current) => ({ ...current, [id]: payoutDecisionErrorMessage(error) }));
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: PAYOUTS_KEY }),
  });

  const payouts = query.data?.pages.flatMap((page) => page.payouts) ?? [];

  return (
    <section>
      <div className="section-head">
        <div>
          <h2>Payouts</h2>
          <p className="muted">
            Vendors' requests to withdraw their wallet balance. The amount is held out of the wallet
            from the moment it is requested. Approve after the bank transfer is made; Reject puts
            the amount back in the wallet.
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

      <div className="filters" role="group" aria-label="Filter by status">
        {PAYOUT_FILTERS.map((filter) => (
          <button
            key={filter.label}
            type="button"
            className="chip"
            aria-pressed={filter.status === status}
            onClick={() => {
              setStatus(filter.status);
            }}
          >
            {filter.label}
          </button>
        ))}
      </div>

      {query.isPending ? (
        <p className="muted">Loading…</p>
      ) : query.isError ? (
        <p className="error" role="alert">
          The payout requests could not be loaded.{' '}
          <button type="button" className="link" onClick={() => void query.refetch()}>
            Try again
          </button>
        </p>
      ) : payouts.length === 0 ? (
        <p className="empty">
          No payout requests{status === undefined ? '' : ' with this status'}.
        </p>
      ) : (
        <ul className="cards">
          {payouts.map((payout) => (
            <PayoutCard
              key={payout.id}
              payout={payout}
              saving={decide.isPending && decide.variables.id === payout.id}
              error={errors[payout.id] ?? null}
              onDecide={(decision) => {
                decide.mutate(decision);
              }}
            />
          ))}
        </ul>
      )}

      {query.hasNextPage && (
        <button
          type="button"
          className="button load-more"
          disabled={query.isFetchingNextPage}
          onClick={() => void query.fetchNextPage()}
        >
          {query.isFetchingNextPage ? 'Loading…' : 'Load older'}
        </button>
      )}
    </section>
  );
}

function PayoutCard({
  payout,
  saving,
  error,
  onDecide,
}: {
  readonly payout: AdminPayoutView;
  readonly saving: boolean;
  readonly error: string | null;
  readonly onDecide: (decision: Decision) => void;
}) {
  const [mode, setMode] = useState<'APPROVE' | 'REJECT' | null>(null);
  const [text, setText] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const inputId = `payout-${payout.id}-${mode ?? 'none'}`;

  const open = (next: 'APPROVE' | 'REJECT') => {
    setMode(next);
    setText('');
    setProblem(null);
  };

  const confirm = () => {
    if (mode === 'APPROVE') {
      const parsed = parseBankReference(text);
      if (!parsed.ok) {
        setProblem(parsed.error);
        return;
      }
      onDecide({ id: payout.id, action: 'APPROVE', bankReference: parsed.value });
    } else if (mode === 'REJECT') {
      const parsed = parseRejectionReason(text);
      if (!parsed.ok) {
        setProblem(parsed.error);
        return;
      }
      onDecide({ id: payout.id, action: 'REJECT', reason: parsed.value });
    }
    setMode(null);
  };

  return (
    <li className="card">
      <div className="card-head">
        <div className="card-title">
          <strong>{formatNpr(payout.amount_npr)}</strong> · {payout.vendor.business_name}
        </div>
        <span className={`badge status-${payout.status.toLowerCase()}`}>
          {PAYOUT_STATUS_LABELS[payout.status]}
        </span>
      </div>

      <dl className="facts">
        <div>
          <dt>Vendor phone</dt>
          <dd>{payout.vendor.phone}</dd>
        </div>
        <div>
          <dt>Wallet now</dt>
          <dd className={payout.vendor.wallet_balance_npr < 0 ? 'negative' : ''}>
            {formatNpr(payout.vendor.wallet_balance_npr)}
          </dd>
        </div>
        <div>
          <dt>Requested</dt>
          <dd>{formatDateTime(payout.requested_at)}</dd>
        </div>
        {payout.decided_at !== null && (
          <div>
            <dt>Decided</dt>
            <dd>{formatDateTime(payout.decided_at)}</dd>
          </div>
        )}
        {payout.bank_reference !== null && (
          <div>
            <dt>Bank reference</dt>
            <dd className="mono">{payout.bank_reference}</dd>
          </div>
        )}
        {payout.rejection_reason !== null && (
          <div>
            <dt>Reason</dt>
            <dd>{payout.rejection_reason}</dd>
          </div>
        )}
      </dl>

      {payout.status === 'PENDING' &&
        (mode === null ? (
          <div className="confirm">
            <button
              type="button"
              className="button primary"
              disabled={saving}
              onClick={() => {
                open('APPROVE');
              }}
            >
              {saving ? 'Saving…' : 'Approve'}
            </button>
            <button
              type="button"
              className="button danger-outline"
              disabled={saving}
              onClick={() => {
                open('REJECT');
              }}
            >
              Reject
            </button>
          </div>
        ) : (
          <form
            className="confirm"
            onSubmit={(event) => {
              event.preventDefault();
              confirm();
            }}
          >
            <label htmlFor={inputId} className="small">
              {mode === 'APPROVE' ? 'Bank transfer reference' : 'Reason (optional)'}
            </label>
            <input
              id={inputId}
              className="search"
              type="text"
              autoFocus
              value={text}
              onChange={(event) => {
                setText(event.target.value);
                setProblem(null);
              }}
            />
            <button type="submit" className={`button ${mode === 'APPROVE' ? 'primary' : 'danger'}`}>
              {mode === 'APPROVE' ? 'Confirm approval' : 'Confirm rejection'}
            </button>
            <button
              type="button"
              className="button ghost"
              onClick={() => {
                setMode(null);
              }}
            >
              Cancel
            </button>
          </form>
        ))}
      {problem !== null && (
        <div className="error small" role="alert">
          {problem}
        </div>
      )}
      {error !== null && (
        <div className="error small" role="alert">
          {error}
        </div>
      )}
    </li>
  );
}
