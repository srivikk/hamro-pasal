import type { AdminPayoutView } from '@hamro-pasal/shared-types';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState, type SyntheticEvent } from 'react';

import { useAdminApi } from '../../app-context';
import { formatDateTime, formatNpr } from '../../lib/format';
import { parseBankReference, parseRejectionReason } from '../finance/payout-rules';
import {
  PROCESSING_TRANSFER_STATE,
  processingTransfers,
  transferActorLabel,
  transferErrorMessage,
} from './settlement-rules';

export const PROCESSING_TRANSFERS_KEY = ['admin', 'payouts', 'processing'] as const;
const SETTLEMENTS_KEY = ['admin', 'settlements'] as const;

/**
 * Bank transfers to make: payouts the scheduled run prepared (the amount has left the shop's
 * wallet) and whose transfer a person still has to make. "Mark Transferred" records the bank
 * reference (POST …/payouts/:id/finalize); "Fail" returns the amount to the wallet
 * (POST …/payouts/:id/fail). The server decides each payout once.
 */
export function ProcessingTransfers() {
  const api = useAdminApi();
  const query = useQuery({
    queryKey: PROCESSING_TRANSFERS_KEY,
    queryFn: () => api.listPayouts({ transferState: PROCESSING_TRANSFER_STATE }),
  });

  if (query.isPending) return <p className="muted">Loading the bank transfers to make…</p>;
  if (query.isError) {
    return (
      <p className="error" role="alert">
        The bank transfers to make could not be loaded.{' '}
        <button type="button" className="link" onClick={() => void query.refetch()}>
          Try again
        </button>
      </p>
    );
  }

  const rows = processingTransfers(query.data.payouts);
  const total = rows.reduce((sum, payout) => sum + Math.round(payout.amount_npr * 100), 0) / 100;

  return (
    <>
      <h2 className="subhead">Bank transfers to make</h2>
      <p className="muted small">
        {rows.length === 0
          ? 'No automated payout is waiting for its bank transfer.'
          : `${String(rows.length)} automated payout${rows.length === 1 ? '' : 's'}, ${formatNpr(total)}. The amount has already left each shop's wallet: make the transfer, then record its reference. If it cannot be made, fail it and the amount goes back to the wallet.`}
        {query.data.next_cursor !== null && ' More are waiting than are shown here.'}
      </p>
      {rows.length > 0 && (
        <div className="table-wrap">
          <table className="table" aria-label="Bank transfers to make">
            <thead>
              <tr>
                <th scope="col">Vendor</th>
                <th scope="col">Primary bank account</th>
                <th scope="col" className="num">
                  Amount
                </th>
                <th scope="col">Prepared</th>
                <th scope="col">Transfer</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((payout) => (
                <TransferRow key={payout.id} payout={payout} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

type Step = 'idle' | 'finalize' | 'fail';

function TransferRow({ payout }: { readonly payout: AdminPayoutView }) {
  const api = useAdminApi();
  const queryClient = useQueryClient();
  const fieldId = useId();
  const [step, setStep] = useState<Step>('idle');
  const [input, setInput] = useState('');
  const [error, setError] = useState<string | null>(null);

  const settle = useMutation({
    mutationFn: (
      action: { kind: 'finalize'; reference: string } | { kind: 'fail'; reason: string | null },
    ) =>
      action.kind === 'finalize'
        ? api.finalizePayout(payout.id, action.reference)
        : api.failPayout(payout.id, action.reason),
    onError: (failure) => {
      setError(transferErrorMessage(failure));
    },
    // Decided or refused, the lists are stale: a failed transfer also changes the shop's balance.
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: PROCESSING_TRANSFERS_KEY }),
        queryClient.invalidateQueries({ queryKey: SETTLEMENTS_KEY }),
      ]),
  });

  const open = (next: Step) => {
    setStep(next);
    setInput('');
    setError(null);
  };

  const submit = (event: SyntheticEvent) => {
    event.preventDefault();
    if (settle.isPending) return;
    if (step === 'finalize') {
      const parsed = parseBankReference(input);
      if (!parsed.ok) {
        setError(parsed.error);
        return;
      }
      setError(null);
      settle.mutate({ kind: 'finalize', reference: parsed.value });
    } else if (step === 'fail') {
      const parsed = parseRejectionReason(input);
      if (!parsed.ok) {
        setError(parsed.error);
        return;
      }
      setError(null);
      settle.mutate({ kind: 'fail', reason: parsed.value });
    }
  };

  const account = payout.primary_bank_account;

  return (
    <tr>
      <td>
        <strong>{payout.vendor.business_name}</strong>
        <div className="muted small">{payout.vendor.phone}</div>
      </td>
      <td>
        {account === null ? (
          <span className="warning small">
            No primary bank account now. Fail this payout, or wait for the vendor to record one.
          </span>
        ) : (
          <>
            <strong>{account.bank_name}</strong>
            <div className="muted small">{account.branch_name}</div>
            <div className="small">{account.account_name}</div>
            <div className="mono">{account.account_number}</div>
            {account.routing_or_swift_code !== null && (
              <div className="muted small">
                Routing / SWIFT <span className="mono">{account.routing_or_swift_code}</span>
              </div>
            )}
          </>
        )}
      </td>
      <td className="num">{formatNpr(payout.amount_npr)}</td>
      <td>
        {formatDateTime(payout.decided_at ?? payout.requested_at)}
        <div>
          <span className="badge status-pending">Processing bank transfer</span>
        </div>
        <div className="muted small">{transferActorLabel(payout)}</div>
      </td>
      <td>
        {step === 'idle' ? (
          <div className="row-actions">
            <button
              type="button"
              className="button primary"
              disabled={account === null}
              onClick={() => {
                open('finalize');
              }}
            >
              Mark Transferred
            </button>
            <button
              type="button"
              className="button danger"
              onClick={() => {
                open('fail');
              }}
            >
              Fail
            </button>
          </div>
        ) : (
          <form onSubmit={submit} noValidate>
            <label htmlFor={fieldId} className="small">
              {step === 'finalize'
                ? 'Bank transfer reference'
                : 'Why the transfer failed (optional, shown to the vendor)'}
            </label>
            <input
              id={fieldId}
              className={step === 'finalize' ? 'mono' : undefined}
              value={input}
              maxLength={step === 'finalize' ? 100 : 500}
              autoFocus
              disabled={settle.isPending}
              onChange={(event) => {
                setInput(event.target.value);
              }}
            />
            <div className="row-actions">
              <button
                type="submit"
                className={`button ${step === 'finalize' ? 'primary' : 'danger'}`}
                disabled={settle.isPending}
              >
                {settle.isPending
                  ? 'Saving…'
                  : step === 'finalize'
                    ? 'Record transfer'
                    : `Return ${formatNpr(payout.amount_npr)} to the wallet`}
              </button>
              <button
                type="button"
                className="button ghost"
                disabled={settle.isPending}
                onClick={() => {
                  open('idle');
                }}
              >
                Cancel
              </button>
            </div>
          </form>
        )}
        {error !== null && (
          <p className="error small" role="alert">
            {error}
          </p>
        )}
      </td>
    </tr>
  );
}
