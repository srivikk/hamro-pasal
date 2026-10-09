import type { AdminVendorListResponseBody, AdminVendorView } from '@hamro-pasal/shared-types';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { ApiError } from '../../api/client';
import { useAdminApi } from '../../app-context';
import { formatNpr } from '../../lib/format';
import {
  matchesSearch,
  overrideErrorMessage,
  SUSPENSION_LABELS,
  vendorAction,
} from './vendor-rules';

const VENDORS_KEY = ['admin', 'vendors'] as const;

interface Override {
  readonly id: string;
  readonly action: 'SUSPEND' | 'RESTORE' | 'REACTIVATE';
}

/**
 * Phase 15 vendor management: every vendor with its wallet balance and standing, and the manual
 * Suspend / Restore overrides (enforced by the API's WalletService).
 */
export function VendorScreen() {
  const api = useAdminApi();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [confirming, setConfirming] = useState<string | null>(null);
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});

  const query = useQuery({ queryKey: VENDORS_KEY, queryFn: () => api.listVendors() });

  const override = useMutation({
    mutationFn: ({ id, action }: Override) => api.overrideVendor(id, action),
    onMutate: ({ id }) => {
      setConfirming(null);
      setErrors(({ [id]: _cleared, ...rest }) => rest);
    },
    onSuccess: (body) => {
      // Show the new standing at once; the refetch below confirms it.
      queryClient.setQueryData<AdminVendorListResponseBody>(VENDORS_KEY, (current) =>
        current === undefined
          ? current
          : {
              ...current,
              vendors: current.vendors.map((vendor) =>
                vendor.id === body.vendor.id ? body.vendor : vendor,
              ),
            },
      );
    },
    onError: (error, { id }) => {
      setErrors((current) => ({ ...current, [id]: overrideErrorMessage(error) }));
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: VENDORS_KEY }),
  });

  if (query.isPending) return <p className="muted">Loading…</p>;
  if (query.isError) {
    return (
      <p className="error" role="alert">
        {query.error instanceof ApiError && query.error.code === 'NETWORK_ERROR'
          ? 'The API cannot be reached.'
          : 'The vendors could not be loaded.'}{' '}
        <button type="button" className="link" onClick={() => void query.refetch()}>
          Try again
        </button>
      </p>
    );
  }

  const { vendors, suspension_limit_npr: limit } = query.data;
  const shown = vendors.filter((vendor) => matchesSearch(vendor, search));
  const suspended = vendors.filter((vendor) => vendor.status === 'SUSPENDED').length;

  return (
    <section>
      <div className="section-head">
        <div>
          <h2>Vendors</h2>
          <p className="muted">
            {vendors.length} vendors · {suspended} suspended · suspension limit {formatNpr(limit)}.
            An admin suspension is only lifted by Restore; paying dues never lifts it.
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

      <input
        className="search"
        type="search"
        placeholder="Search by name, phone or Palika"
        aria-label="Search vendors"
        value={search}
        onChange={(event) => {
          setSearch(event.target.value);
        }}
      />

      {shown.length === 0 ? (
        <p className="empty">No vendors match.</p>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Vendor</th>
                <th scope="col">Status</th>
                <th scope="col" className="num">
                  Wallet
                </th>
                <th scope="col">Override</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((vendor) => (
                <VendorRow
                  key={vendor.id}
                  vendor={vendor}
                  limit={limit}
                  confirming={confirming === vendor.id}
                  saving={override.isPending && override.variables.id === vendor.id}
                  error={errors[vendor.id] ?? null}
                  onAsk={() => {
                    setConfirming(vendor.id);
                  }}
                  onCancel={() => {
                    setConfirming(null);
                  }}
                  onConfirm={(action) => {
                    override.mutate({ id: vendor.id, action });
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

function VendorRow({
  vendor,
  limit,
  confirming,
  saving,
  error,
  onAsk,
  onCancel,
  onConfirm,
}: {
  readonly vendor: AdminVendorView;
  readonly limit: number;
  readonly confirming: boolean;
  readonly saving: boolean;
  readonly error: string | null;
  readonly onAsk: () => void;
  readonly onCancel: () => void;
  readonly onConfirm: (action: 'SUSPEND' | 'RESTORE' | 'REACTIVATE') => void;
}) {
  const button = vendorAction(vendor, limit);
  const label =
    button.action === 'SUSPEND'
      ? 'Suspend'
      : button.action === 'RESTORE'
        ? 'Restore'
        : 'Reactivate';

  return (
    <tr>
      <td>
        <strong>{vendor.business_name}</strong>
        <div className="muted small">
          {vendor.phone} · {vendor.municipality_palika_string}
        </div>
      </td>
      <td>
        <span className={`badge suspension-${vendor.suspension.toLowerCase()}`}>
          {vendor.status}
        </span>
        <div className="muted small">{SUSPENSION_LABELS[vendor.suspension]}</div>
      </td>
      <td className={`num ${vendor.wallet_balance_npr < 0 ? 'negative' : ''}`}>
        {formatNpr(vendor.wallet_balance_npr)}
      </td>
      <td>
        {confirming ? (
          <div className="confirm">
            <button
              type="button"
              className={`button ${button.action === 'SUSPEND' ? 'danger' : 'primary'}`}
              onClick={() => {
                onConfirm(button.action);
              }}
            >
              Confirm {label.toLowerCase()}
            </button>
            <button type="button" className="button ghost" onClick={onCancel}>
              Cancel
            </button>
          </div>
        ) : (
          <button
            type="button"
            className={`button ${button.action === 'SUSPEND' ? 'danger-outline' : 'primary'}`}
            disabled={!button.enabled || saving}
            onClick={onAsk}
          >
            {saving ? 'Saving…' : label}
          </button>
        )}
        {button.note !== null && <div className="muted small note">{button.note}</div>}
        {error !== null && (
          <div className="error small" role="alert">
            {error}
          </div>
        )}
      </td>
    </tr>
  );
}
