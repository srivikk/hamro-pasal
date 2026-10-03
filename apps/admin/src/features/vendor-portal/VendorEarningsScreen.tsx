import type { VendorFinanceLedgerResponseBody } from '@hamro-pasal/shared-types';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';

import { ApiError } from '../../api/client';
import { useAdminApi } from '../../app-context';
import { formatDateTime, formatNpr } from '../../lib/format';
import {
  canRequestPayout,
  parsePayoutAmount,
  PAYOUT_STATUS_LABELS,
  payoutRequestErrorMessage,
} from '../finance/payout-rules';

const EARNINGS_KEY = ['vendor', 'finance', 'ledger'] as const;

/**
 * Phase 22, the Vendor Portal's Earnings tab: the shop's balance (the wallet), what is still in
 * escrow, the orders the nightly reconciliation has verified, and bank withdrawals.
 */
export function VendorEarningsScreen() {
  const api = useAdminApi();
  const queryClient = useQueryClient();
  const [amount, setAmount] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // One key per withdrawal attempt, kept until it succeeds: a retry after a lost response returns
  // the same request instead of holding the amount twice.
  const attempt = useRef<{ readonly amount: number; readonly key: string } | null>(null);

  const query = useQuery({ queryKey: EARNINGS_KEY, queryFn: () => api.getOwnFinanceLedger() });

  const request = useMutation({
    mutationFn: (amountNpr: number) => {
      if (attempt.current?.amount !== amountNpr) {
        attempt.current = { amount: amountNpr, key: crypto.randomUUID() };
      }
      return api.requestOwnPayout(amountNpr, attempt.current.key);
    },
    onMutate: () => {
      setProblem(null);
      setNotice(null);
    },
    onSuccess: ({ payout, available_balance_npr: available }) => {
      attempt.current = null;
      setAmount('');
      setNotice(`Payout of ${formatNpr(payout.amount_npr)} requested. It is waiting for approval.`);
      queryClient.setQueryData<VendorFinanceLedgerResponseBody>(EARNINGS_KEY, (current) =>
        current === undefined
          ? current
          : {
              ...current,
              available_balance_npr: available,
              pending_payout_npr: current.payouts.some((p) => p.id === payout.id)
                ? current.pending_payout_npr
                : current.pending_payout_npr + payout.amount_npr,
              payouts: [payout, ...current.payouts.filter((p) => p.id !== payout.id)],
            },
      );
    },
    onError: (error) => {
      // A refusal ends the attempt; a network failure keeps its key for the retry.
      if (error instanceof ApiError && error.code !== 'NETWORK_ERROR') attempt.current = null;
      setProblem(payoutRequestErrorMessage(error));
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: EARNINGS_KEY }),
  });

  if (query.isPending) return <p className="muted">Loading…</p>;
  if (query.isError) {
    return (
      <p className="error" role="alert">
        {query.error instanceof ApiError && query.error.code === 'NETWORK_ERROR'
          ? 'The API cannot be reached.'
          : 'Your earnings could not be loaded.'}{' '}
        <button type="button" className="link" onClick={() => void query.refetch()}>
          Try again
        </button>
      </p>
    );
  }

  const ledger = query.data;
  const available = ledger.available_balance_npr;

  return (
    <section>
      <div className="section-head">
        <div>
          <h2>Earnings</h2>
          <p className="muted">
            Your balance is what delivered orders have earned the shop, after the platform
            commission and anything you have withdrawn.
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

      <dl className="facts">
        <div>
          <dt>Available balance</dt>
          <dd className={available < 0 ? 'negative' : ''}>
            <strong>{formatNpr(available)}</strong>
          </dd>
        </div>
        <div>
          <dt>Pending (paid orders not delivered yet)</dt>
          <dd>{formatNpr(ledger.pending_balance_npr)}</dd>
        </div>
        <div>
          <dt>Payouts waiting for approval</dt>
          <dd>{formatNpr(ledger.pending_payout_npr)}</dd>
        </div>
        <div>
          <dt>Delivered orders not reconciled yet</dt>
          <dd>{ledger.unreconciled_order_count}</dd>
        </div>
      </dl>

      <form
        className="confirm"
        onSubmit={(event) => {
          event.preventDefault();
          const parsed = parsePayoutAmount(amount, available);
          if (!parsed.ok) {
            setProblem(parsed.error);
            return;
          }
          request.mutate(parsed.value);
        }}
      >
        <label htmlFor="payout-amount" className="small">
          Amount to withdraw (Rs.)
        </label>
        <input
          id="payout-amount"
          className="stock-input"
          type="text"
          inputMode="decimal"
          value={amount}
          disabled={!canRequestPayout(ledger) || request.isPending}
          onChange={(event) => {
            setAmount(event.target.value);
            setProblem(null);
          }}
        />
        <button
          type="submit"
          className="button primary"
          disabled={!canRequestPayout(ledger) || request.isPending}
        >
          {request.isPending ? 'Requesting…' : 'Request payout'}
        </button>
      </form>
      {!canRequestPayout(ledger) && (
        <p className="muted small note">
          {available < 0
            ? 'Your wallet is in debt, so there is nothing to withdraw.'
            : 'There is nothing to withdraw yet.'}
        </p>
      )}
      {problem !== null && (
        <p className="error small" role="alert">
          {problem}
        </p>
      )}
      {notice !== null && (
        <p className="small" role="status">
          {notice}
        </p>
      )}

      <h3>Payout requests</h3>
      {ledger.payouts.length === 0 ? (
        <p className="empty">No payout requests yet.</p>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Requested</th>
                <th scope="col" className="num">
                  Amount
                </th>
                <th scope="col">Status</th>
                <th scope="col">Details</th>
              </tr>
            </thead>
            <tbody>
              {ledger.payouts.map((payout) => (
                <tr key={payout.id}>
                  <td>{formatDateTime(payout.requested_at)}</td>
                  <td className="num">{formatNpr(payout.amount_npr)}</td>
                  <td>
                    <span className={`badge status-${payout.status.toLowerCase()}`}>
                      {PAYOUT_STATUS_LABELS[payout.status]}
                    </span>
                  </td>
                  <td className="small">
                    {payout.status === 'APPROVED' && <>Bank reference {payout.bank_reference}</>}
                    {payout.status === 'REJECTED' && (
                      <>Returned to your balance. {payout.rejection_reason}</>
                    )}
                    {payout.status === 'PENDING' && <span className="muted">Being reviewed</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h3>Reconciled orders</h3>
      {ledger.reconciled_orders.length === 0 ? (
        <p className="empty">No reconciled orders yet. Delivered orders are checked every night.</p>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Order</th>
                <th scope="col">Reconciled</th>
                <th scope="col" className="num">
                  Subtotal
                </th>
                <th scope="col" className="num">
                  Commission
                </th>
                <th scope="col" className="num">
                  Your cut
                </th>
                <th scope="col" className="num">
                  Wallet
                </th>
              </tr>
            </thead>
            <tbody>
              {ledger.reconciled_orders.map((order) => (
                <tr key={order.order_id}>
                  <td>
                    <span className="mono">#{order.order_id.slice(-6).toUpperCase()}</span>
                    <div className="muted small">
                      {order.payment_method} · {order.fulfillment}
                    </div>
                  </td>
                  <td>{formatDateTime(order.reconciled_at)}</td>
                  <td className="num">{formatNpr(order.subtotal_npr)}</td>
                  <td className="num">{formatNpr(order.commission_npr)}</td>
                  <td className="num">{formatNpr(order.vendor_cut_npr)}</td>
                  <td className={`num ${order.wallet_amount_npr < 0 ? 'negative' : ''}`}>
                    {formatNpr(order.wallet_amount_npr)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
