import type {
  AdminSettlementListResponseBody,
  SettlementPayoutResponseBody,
} from '@hamro-pasal/shared-types';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState, type SyntheticEvent } from 'react';

import { ApiError } from '../../api/client';
import { useAdminApi } from '../../app-context';
import { formatDateTime, formatNpr } from '../../lib/format';
import {
  PAYOUT_BLOCKER_MESSAGES,
  payableVendors,
  payoutButton,
  payoutFormFor,
  payoutSaveError,
  replaceSettlementVendor,
  settlementTotals,
  validatePayoutForm,
  type PayoutFormField,
  type PayoutFormValues,
  type SettlementPayoutRequest,
  type SettlementVendorView,
} from './settlement-rules';

const SETTLEMENTS_KEY = ['admin', 'settlements'] as const;

/** A payout recorded in this sitting, with the shop it went to. */
interface RecordedPayout {
  readonly id: string;
  readonly businessName: string;
  readonly amountNpr: number;
  readonly bankReference: string | null;
  readonly recordedAt: string;
}

/**
 * Settlements: the escrow money the platform holds for Model B (PLATFORM_ESCROW) shops and may now
 * pay out (GET /api/admin/finance/settlements). Two gates hold a transfer: the shop's PAN document
 * must be verified on the Compliance tab, and the shop must have a primary bank account to send it
 * to. The shop trades meanwhile; only the transfer waits. The server checks both again.
 */
export function SettlementScreen() {
  const api = useAdminApi();
  const queryClient = useQueryClient();
  const [recorded, setRecorded] = useState<readonly RecordedPayout[]>([]);
  const [paying, setPaying] = useState<SettlementVendorView | null>(null);

  const query = useQuery({ queryKey: SETTLEMENTS_KEY, queryFn: () => api.listSettlements() });

  if (query.isPending) return <p className="muted">Loading…</p>;
  if (query.isError) {
    return (
      <p className="error" role="alert">
        {query.error instanceof ApiError && query.error.code === 'NETWORK_ERROR'
          ? 'The API cannot be reached.'
          : 'The settlements could not be loaded.'}{' '}
        <button type="button" className="link" onClick={() => void query.refetch()}>
          Try again
        </button>
      </p>
    );
  }

  const { vendors } = query.data;
  const rows = payableVendors(vendors);
  const totals = settlementTotals(vendors);

  const paid = (body: SettlementPayoutResponseBody) => {
    // Show the shop's new balance at once; the modal's invalidation confirms it.
    queryClient.setQueryData<AdminSettlementListResponseBody>(SETTLEMENTS_KEY, (current) =>
      current === undefined ? current : replaceSettlementVendor(current, body.vendor),
    );
    setRecorded((current) =>
      // A replayed attempt answers the payout already listed.
      current.some((payout) => payout.id === body.payout.id)
        ? current
        : [
            {
              id: body.payout.id,
              businessName: body.vendor.business_name,
              amountNpr: body.payout.amount_npr,
              bankReference: body.payout.bank_reference,
              recordedAt: body.payout.decided_at ?? body.payout.requested_at,
            },
            ...current,
          ],
    );
    setPaying(null);
  };

  return (
    <section>
      <div className="section-head">
        <div>
          <h2>Settlements</h2>
          <p className="muted">
            {rows.length} escrow shops with money available · {formatNpr(totals.readyNpr)} ready to
            pay · {formatNpr(totals.heldNpr)} held for {totals.heldCount} shop
            {totals.heldCount === 1 ? '' : 's'} awaiting PAN verification or a bank account. Money
            still in escrow for undelivered orders is not payable.
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

      {rows.length === 0 ? (
        <p className="empty">No escrow shop has money available for payout.</p>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Vendor</th>
                <th scope="col">PAN</th>
                <th scope="col">Primary bank account</th>
                <th scope="col" className="num">
                  Available for payout
                </th>
                <th scope="col" className="num">
                  Still in escrow
                </th>
                <th scope="col">Payout</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((vendor) => (
                <SettlementRow
                  key={vendor.vendor_id}
                  vendor={vendor}
                  onPay={() => {
                    setPaying(vendor);
                  }}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {recorded.length > 0 && (
        <>
          <h2 className="subhead">Recorded in this sitting</h2>
          <ul className="cards" aria-label="Recorded payouts">
            {recorded.map((payout) => (
              <li key={payout.id} className="card">
                <div className="card-title">
                  <strong>{formatNpr(payout.amountNpr)}</strong>
                  <span>to {payout.businessName}</span>
                  <span className="badge status-approved">Paid</span>
                </div>
                <div className="muted small">
                  Bank reference <span className="mono">{payout.bankReference ?? 'none'}</span> ·{' '}
                  {formatDateTime(payout.recordedAt)}
                </div>
              </li>
            ))}
          </ul>
        </>
      )}

      {paying !== null && (
        <PayoutModal
          // Unmounted on close, so every opening is a new attempt with its own idempotency key.
          key={paying.vendor_id}
          vendor={paying}
          onPaid={paid}
          onClose={() => {
            setPaying(null);
          }}
        />
      )}
    </section>
  );
}

function BankAccount({
  account,
}: {
  readonly account: SettlementVendorView['primary_bank_account'];
}) {
  if (account === null) return <span className="muted">None</span>;
  return (
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
  );
}

function SettlementRow({
  vendor,
  onPay,
}: {
  readonly vendor: SettlementVendorView;
  readonly onPay: () => void;
}) {
  const button = payoutButton(vendor);
  const tooltipId = useId();

  return (
    <tr>
      <td>
        <strong>{vendor.business_name}</strong>
        <div className="muted small">{vendor.phone}</div>
      </td>
      <td>
        <span className="mono">{vendor.tax_id ?? 'None'}</span>
        <div>
          <span
            className={`badge ${vendor.pan_verified_at === null ? 'pan-unverified' : 'pan-verified'}`}
          >
            {vendor.pan_verified_at === null ? 'Not verified' : 'Verified'}
          </span>
        </div>
      </td>
      <td>
        <BankAccount account={vendor.primary_bank_account} />
      </td>
      <td className="num">{formatNpr(vendor.available_for_payout_npr)}</td>
      <td className="num muted">{formatNpr(vendor.pending_escrow_npr)}</td>
      <td>
        {/* A disabled button fires no pointer events in some browsers, so the wrapper carries the tooltip. */}
        <span className="tooltip-anchor" title={button.tooltip ?? undefined}>
          <button
            type="button"
            className="button primary"
            disabled={!button.enabled}
            aria-describedby={button.enabled ? undefined : tooltipId}
            onClick={onPay}
          >
            Process Payout
          </button>
        </span>
        {!button.enabled && (
          <div id={tooltipId} className="warning small note" role="note">
            {button.blockers.map((blocker) => (
              <div key={blocker}>
                {PAYOUT_BLOCKER_MESSAGES[blocker]}{' '}
                {blocker === 'PAN' ? (
                  <a className="link" href="#/compliance">
                    Open Compliance
                  </a>
                ) : (
                  'The vendor records it from its own account.'
                )}
              </div>
            ))}
          </div>
        )}
      </td>
    </tr>
  );
}

function PayoutModal({
  vendor,
  onPaid,
  onClose,
}: {
  readonly vendor: SettlementVendorView;
  readonly onPaid: (body: SettlementPayoutResponseBody) => void;
  readonly onClose: () => void;
}) {
  const api = useAdminApi();
  const queryClient = useQueryClient();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const formId = useId();
  // One key per opening of this window, kept across its retries: a retry after a lost answer
  // gets the stored payout back instead of recording a second one.
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const [values, setValues] = useState<PayoutFormValues>(() => payoutFormFor(vendor));
  const [fieldErrors, setFieldErrors] = useState<
    Readonly<Partial<Record<PayoutFormField, string>>>
  >({});
  const [blocked, setBlocked] = useState<string | null>(null);

  const pay = useMutation({
    mutationFn: (request: SettlementPayoutRequest) =>
      api.processSettlementPayout(vendor.vendor_id, request),
    onSuccess: onPaid,
    onError: (error) => {
      const refusal = payoutSaveError(error);
      if (refusal.field === null) setBlocked(refusal.message);
      else setFieldErrors({ [refusal.field]: refusal.message });
    },
    // A refusal means the list is stale (the PAN, the account or the balance changed).
    onSettled: () => queryClient.invalidateQueries({ queryKey: SETTLEMENTS_KEY }),
  });

  // A native modal dialog: focus is trapped inside it and Escape closes it.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog !== null && !dialog.open) dialog.showModal();
  }, []);

  const submit = (event: SyntheticEvent) => {
    event.preventDefault();
    if (pay.isPending) return;
    const result = validatePayoutForm(vendor, values, idempotencyKey);
    if (!result.ok) {
      setFieldErrors(result.errors);
      setBlocked(result.blocked);
      return;
    }
    setFieldErrors({});
    setBlocked(null);
    pay.mutate(result.request);
  };

  const field = (name: PayoutFormField) => `${formId}-${name}`;
  const errorOf = (name: PayoutFormField) =>
    fieldErrors[name] === undefined ? null : (
      <span className="error small" role="alert">
        {fieldErrors[name]}
      </span>
    );

  return (
    <dialog ref={dialogRef} className="modal" aria-labelledby={`${formId}-title`} onClose={onClose}>
      <form onSubmit={submit} noValidate>
        <h2 id={`${formId}-title`}>Pay {vendor.business_name}</h2>
        <p className="muted small">
          {formatNpr(vendor.available_for_payout_npr)} available. Make the bank transfer to the
          account below first, then record its reference here.
        </p>
        <div className="small">
          <BankAccount account={vendor.primary_bank_account} />
        </div>

        <label htmlFor={field('amount')}>Amount (NPR)</label>
        <input
          id={field('amount')}
          inputMode="decimal"
          value={values.amount}
          autoFocus
          disabled={pay.isPending}
          onChange={(event) => {
            setValues((current) => ({ ...current, amount: event.target.value }));
          }}
        />
        {errorOf('amount')}

        <label htmlFor={field('bankReference')}>Bank transfer reference</label>
        <input
          id={field('bankReference')}
          className="mono"
          value={values.bankReference}
          maxLength={100}
          disabled={pay.isPending}
          onChange={(event) => {
            setValues((current) => ({ ...current, bankReference: event.target.value }));
          }}
        />
        {errorOf('bankReference')}

        {blocked !== null && (
          <p className="error" role="alert">
            {blocked}
          </p>
        )}

        <div className="modal-actions">
          <button type="button" className="button ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="button primary" disabled={pay.isPending}>
            {pay.isPending ? 'Recording…' : 'Record payout'}
          </button>
        </div>
      </form>
    </dialog>
  );
}
