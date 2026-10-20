import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { useAdminApi } from '../../app-context';
import { formatDateTime } from '../../lib/format';
import { REVIEW_REASON_LABELS, similarityLabel } from './dashboard-rules';

export const MANUAL_REVIEW_KEY = ['admin', 'kyc', 'manual-review'] as const;

/**
 * "Action Required: Manual Review" (2026-10-21): the vendor applications the automated IRD check
 * could not settle, oldest first, with what the IRD said and why it stopped. A Super Admin then
 * verifies the PAN by hand on the Compliance tab (which closes the check), or asks the worker to
 * try again (after the IRD site was down, say).
 */
export function ManualReviewQueue() {
  const api = useAdminApi();
  const queryClient = useQueryClient();
  const queue = useQuery({ queryKey: MANUAL_REVIEW_KEY, queryFn: () => api.listIrdManualReview() });
  const retry = useMutation({
    mutationFn: (checkId: string) => api.retryIrdCheck(checkId),
    onSettled: () => queryClient.invalidateQueries({ queryKey: MANUAL_REVIEW_KEY }),
  });

  const checks = queue.data?.checks ?? [];
  return (
    <div
      className={`card ${checks.length > 0 ? 'action-required' : ''}`}
      data-testid="manual-review"
    >
      <div className="card-head">
        <h2 className="card-title">
          Action Required: Manual Review
          {checks.length > 0 ? <span className="count-badge">{checks.length}</span> : null}
        </h2>
        <a className="link" href="#/compliance">
          Verify on the Compliance tab
        </a>
      </div>
      {queue.isPending ? (
        <p className="muted">Loading…</p>
      ) : queue.isError ? (
        <p className="error" role="alert">
          The review queue could not be loaded.
        </p>
      ) : checks.length === 0 ? (
        <p className="muted">Every IRD check settled itself. Nothing needs you.</p>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Shop</th>
                <th scope="col">PAN</th>
                <th scope="col">Why</th>
                <th scope="col">IRD says</th>
                <th scope="col">Since</th>
                <th scope="col" aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {checks.map((check) => (
                <tr key={check.check_id}>
                  <td>
                    {check.business_name}
                    <div className="muted small">
                      {check.vendor_code}
                      {check.legal_name === null ? '' : ` · ${check.legal_name}`}
                    </div>
                  </td>
                  <td className="mono">{check.tax_id}</td>
                  <td>
                    <span className="status-pill pending">
                      {REVIEW_REASON_LABELS[check.reason]}
                    </span>
                    {check.last_error === null ? null : (
                      <div className="muted small">{check.last_error}</div>
                    )}
                  </td>
                  <td>
                    {check.ird_business_name ?? '—'}
                    {check.name_similarity === null ? null : (
                      <div className="muted small">{similarityLabel(check.name_similarity)}</div>
                    )}
                    {check.ird_registration_date === null ? null : (
                      <div className="muted small">Registered {check.ird_registration_date}</div>
                    )}
                  </td>
                  <td>
                    {formatDateTime(check.completed_at ?? check.requested_at)}
                    <div className="muted small">
                      {check.attempts} attempt{check.attempts === 1 ? '' : 's'}
                    </div>
                  </td>
                  <td>
                    <button
                      type="button"
                      className="button"
                      disabled={retry.isPending && retry.variables === check.check_id}
                      onClick={() => {
                        retry.mutate(check.check_id);
                      }}
                    >
                      {retry.isPending && retry.variables === check.check_id
                        ? 'Queuing…'
                        : 'Try again'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {retry.isError ? (
        <p className="error small" role="alert">
          The check could not be queued again. Reload and try once more.
        </p>
      ) : null}
    </div>
  );
}
