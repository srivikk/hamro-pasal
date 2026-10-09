import type { AdminComplianceVendorListResponseBody } from '@hamro-pasal/shared-types';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';

import { ApiError } from '../../api/client';
import { useAdminApi } from '../../app-context';
import { formatDateTime } from '../../lib/format';
import {
  COMPLIANCE_FILTERS,
  complianceRows,
  countByStanding,
  PAN_STANDING_LABELS,
  panDocumentErrorMessage,
  panStandingOf,
  replaceComplianceVendor,
  verifyButton,
  verifyErrorMessage,
  type ComplianceVendorView,
  type PanStanding,
} from './compliance-rules';

const COMPLIANCE_KEY = ['admin', 'compliance'] as const;

/**
 * PAN / KYC compliance (SPEC core section 10, "PAN is mandatory"): every vendor's PAN standing
 * from GET /api/admin/compliance/vendors, opening on the shops that are offline as
 * SUSPENDED_COMPLIANCE, and the Super Admin's check of a PAN on file
 * (POST /api/admin/vendors/:id/pan-verification), which gates payouts and never changes `status`.
 */
export function ComplianceScreen() {
  const api = useAdminApi();
  const queryClient = useQueryClient();
  const [standing, setStanding] = useState<PanStanding | undefined>('SUSPENDED');
  const [search, setSearch] = useState('');
  const [confirming, setConfirming] = useState<string | null>(null);
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});
  const [viewing, setViewing] = useState<ComplianceVendorView | null>(null);

  const query = useQuery({
    queryKey: COMPLIANCE_KEY,
    queryFn: () => api.listComplianceVendors(),
  });

  const verify = useMutation({
    mutationFn: (id: string) => api.verifyVendorPan(id),
    onMutate: (id) => {
      setConfirming(null);
      setErrors(({ [id]: _cleared, ...rest }) => rest);
    },
    onSuccess: (body) => {
      // Show the stamp at once; the refetch below confirms it.
      queryClient.setQueryData<AdminComplianceVendorListResponseBody>(COMPLIANCE_KEY, (current) =>
        current === undefined ? current : replaceComplianceVendor(current, body.vendor),
      );
    },
    onError: (error, id) => {
      setErrors((current) => ({ ...current, [id]: verifyErrorMessage(error) }));
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: COMPLIANCE_KEY }),
  });

  if (query.isPending) return <p className="muted">Loading…</p>;
  if (query.isError) {
    return (
      <p className="error" role="alert">
        {query.error instanceof ApiError && query.error.code === 'NETWORK_ERROR'
          ? 'The API cannot be reached.'
          : 'The compliance list could not be loaded.'}{' '}
        <button type="button" className="link" onClick={() => void query.refetch()}>
          Try again
        </button>
      </p>
    );
  }

  const { vendors } = query.data;
  const counts = countByStanding(vendors);
  const shown = complianceRows(vendors, standing, search);

  return (
    <section>
      <div className="section-head">
        <div>
          <h2>Compliance</h2>
          <p className="muted">
            {vendors.length} vendors · {counts.SUSPENDED} suspended for compliance ·{' '}
            {counts.MISSING} more without a PAN · {counts.UNVERIFIED} awaiting verification. A
            compliance suspension is lifted only by the vendor saving its PAN in the Vendor App:
            paying dues or an admin Restore never lifts it. A shop with a PAN trades at once, but
            its payouts are held until the document is verified here.
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

      <div className="filters" role="group" aria-label="PAN standing">
        {COMPLIANCE_FILTERS.map((filter) => (
          <button
            key={filter.label}
            type="button"
            className="chip"
            aria-pressed={standing === filter.standing}
            onClick={() => {
              setStanding(filter.standing);
            }}
          >
            {filter.label} (
            {filter.standing === undefined ? vendors.length : counts[filter.standing]})
          </button>
        ))}
      </div>

      <input
        className="search"
        type="search"
        placeholder="Search by name, phone, Palika or PAN"
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
                <th scope="col">PAN</th>
                <th scope="col">Document</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((vendor) => (
                <ComplianceRow
                  key={vendor.id}
                  vendor={vendor}
                  confirming={confirming === vendor.id}
                  busy={verify.isPending}
                  saving={verify.isPending && verify.variables === vendor.id}
                  error={errors[vendor.id] ?? null}
                  onViewDocument={() => {
                    setViewing(vendor);
                  }}
                  onAsk={() => {
                    setConfirming(vendor.id);
                  }}
                  onCancel={() => {
                    setConfirming(null);
                  }}
                  onConfirm={() => {
                    verify.mutate(vendor.id);
                  }}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {viewing !== null && (
        <PanDocumentDialog
          key={viewing.id}
          vendor={viewing}
          onClose={() => {
            setViewing(null);
          }}
        />
      )}
    </section>
  );
}

/**
 * The vendor's uploaded PAN document. It lives in a private bucket: the image is fetched through
 * the API with the admin's token and shown from memory, and that copy is dropped when the dialog
 * closes.
 */
function PanDocumentDialog({
  vendor,
  onClose,
}: {
  readonly vendor: ComplianceVendorView;
  readonly onClose: () => void;
}) {
  const api = useAdminApi();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [state, setState] = useState<
    | { readonly status: 'loading' }
    | { readonly status: 'ready'; readonly url: string }
    | { readonly status: 'error'; readonly message: string }
  >({ status: 'loading' });

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog !== null && !dialog.open) dialog.showModal();
  }, []);

  useEffect(() => {
    let objectUrl: string | null = null;
    let cancelled = false;
    api
      .getVendorPanDocument(vendor.id)
      .then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setState({ status: 'ready', url: objectUrl });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setState({ status: 'error', message: panDocumentErrorMessage(error) });
      });
    return () => {
      cancelled = true;
      if (objectUrl !== null) URL.revokeObjectURL(objectUrl);
    };
  }, [api, vendor.id]);

  return (
    <dialog ref={dialogRef} className="modal modal-wide document-view" onClose={onClose}>
      <h2>PAN document of {vendor.business_name}</h2>
      <p className="muted">
        PAN on file:{' '}
        {vendor.tax_id === null ? 'none' : <span className="mono">{vendor.tax_id}</span>}. Check
        that the number and the name on the document match before verifying.
      </p>
      {state.status === 'loading' && (
        <p className="uploading" role="status">
          <span className="spinner" aria-hidden="true" /> Loading the document…
        </p>
      )}
      {state.status === 'error' && (
        <p className="error" role="alert">
          {state.message}
        </p>
      )}
      {state.status === 'ready' && (
        <img src={state.url} alt={`PAN document uploaded by ${vendor.business_name}`} />
      )}
      <div className="modal-actions">
        <button type="button" className="button" onClick={onClose}>
          Close
        </button>
      </div>
    </dialog>
  );
}

function ComplianceRow({
  vendor,
  confirming,
  busy,
  saving,
  error,
  onViewDocument,
  onAsk,
  onCancel,
  onConfirm,
}: {
  readonly vendor: ComplianceVendorView;
  readonly confirming: boolean;
  /** A verification is in flight (this row's or another's): no second one is started. */
  readonly busy: boolean;
  readonly saving: boolean;
  readonly error: string | null;
  readonly onViewDocument: () => void;
  readonly onAsk: () => void;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}) {
  const current = panStandingOf(vendor);
  const button = verifyButton(vendor);

  return (
    <tr>
      <td>
        <strong>{vendor.business_name}</strong>
        <div className="muted small">
          {vendor.phone} · {vendor.municipality_palika_string}
        </div>
        {vendor.legal_name !== null && vendor.legal_name !== vendor.business_name && (
          <div className="muted small">Legal name: {vendor.legal_name}</div>
        )}
      </td>
      <td>
        <span className={`badge pan-${current.toLowerCase()}`}>{vendor.status}</span>
        {vendor.compliance_suspended_at !== null && (
          <div className="muted small">
            Offline since {formatDateTime(vendor.compliance_suspended_at)}
          </div>
        )}
      </td>
      <td>
        {vendor.tax_id === null ? (
          <span className="muted">None</span>
        ) : (
          <span className="mono">{vendor.tax_id}</span>
        )}
        <div className="muted small">
          {PAN_STANDING_LABELS[current]}
          {vendor.tax_id !== null &&
            (vendor.is_vat_registered ? ' · VAT registered' : ' · PAN only')}
        </div>
        {vendor.has_pan_document ? (
          <button type="button" className="link" onClick={onViewDocument}>
            View document
          </button>
        ) : (
          <div className="muted small">No document uploaded</div>
        )}
      </td>
      <td>
        {confirming ? (
          <div className="confirm">
            <button
              type="button"
              className="button primary"
              disabled={current !== 'UNVERIFIED' || busy}
              onClick={onConfirm}
            >
              Confirm verified
            </button>
            <button type="button" className="button ghost" onClick={onCancel}>
              Cancel
            </button>
          </div>
        ) : (
          <button
            type="button"
            className="button"
            disabled={current !== 'UNVERIFIED' || busy}
            onClick={onAsk}
          >
            {saving ? 'Saving…' : button.label}
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
