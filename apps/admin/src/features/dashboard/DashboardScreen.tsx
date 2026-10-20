import { useQuery } from '@tanstack/react-query';

import { useAdminApi } from '../../app-context';
import { formatDateTime, formatNpr } from '../../lib/format';
import {
  approvalQueue,
  dashboardStats,
  shopsByMunicipality,
  signupsPerMonth,
  type BarDatum,
} from './dashboard-rules';

/** The same cache entries the Vendors and Settlements tabs use: no extra request on switching. */
const VENDORS_KEY = ['admin', 'vendors'] as const;
const SETTLEMENTS_KEY = ['admin', 'settlements'] as const;

function StatCard({
  label,
  value,
  tone = 'plain',
  testId,
}: {
  label: string;
  value: string;
  tone?: 'plain' | 'attention';
  testId: string;
}) {
  return (
    <div
      className={`stat-card ${tone === 'attention' ? 'stat-attention' : ''}`}
      data-testid={testId}
    >
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value}</span>
    </div>
  );
}

/**
 * A single-series bar chart in plain HTML: one hue (the brand red), the value written beside each
 * bar, the exact figure in each bar's tooltip, and the chart's title naming what is counted (one
 * series, so no legend). `direction="column"` draws a time series left to right.
 */
function BarChart({
  title,
  data,
  direction,
  unit,
}: {
  title: string;
  data: readonly BarDatum[];
  direction: 'row' | 'column';
  unit: string;
}) {
  const max = Math.max(1, ...data.map((bar) => bar.value));
  return (
    <figure className="chart-card">
      <figcaption className="card-title">{title}</figcaption>
      {data.length === 0 ? (
        <p className="muted">Nothing to show yet.</p>
      ) : (
        <ul className={`bars bars-${direction}`} aria-label={title}>
          {data.map((bar) => {
            const share = `${String(Math.round((bar.value / max) * 100))}%`;
            const tooltip = `${bar.label}: ${String(bar.value)} ${unit}`;
            return (
              <li key={bar.label} className="bar-item" title={tooltip}>
                <span className="bar-label">{bar.label}</span>
                <span className="bar-track">
                  <span
                    className="bar-fill"
                    style={direction === 'row' ? { width: share } : { height: share }}
                  />
                </span>
                <span className="bar-value">{bar.value}</span>
              </li>
            );
          })}
        </ul>
      )}
    </figure>
  );
}

/**
 * Super Admin → Dashboard: the platform at a glance. Stat cards, two charts and the approval
 * queue, all counted from GET /api/admin/vendors and GET /api/admin/finance/settlements.
 */
export function DashboardScreen() {
  const api = useAdminApi();
  const vendors = useQuery({ queryKey: VENDORS_KEY, queryFn: () => api.listVendors() });
  const settlements = useQuery({ queryKey: SETTLEMENTS_KEY, queryFn: () => api.listSettlements() });

  if (vendors.isPending) return <p className="muted">Loading…</p>;
  if (vendors.isError) {
    return (
      <p className="error" role="alert">
        The dashboard could not be loaded.{' '}
        <button
          type="button"
          className="link"
          onClick={() => {
            void vendors.refetch();
          }}
        >
          Try again
        </button>
      </p>
    );
  }

  const list = vendors.data.vendors;
  const stats = dashboardStats(list);
  const queue = approvalQueue(list);
  const owed =
    settlements.data === undefined
      ? '…'
      : formatNpr(
          settlements.data.vendors.reduce(
            (sum, vendor) => sum + vendor.available_for_payout_npr,
            0,
          ),
        );

  return (
    <section className="dashboard" aria-labelledby="dashboard-title">
      <h1 id="dashboard-title">Dashboard</h1>

      <div className="stat-grid">
        <StatCard label="Live shops" value={String(stats.liveShops)} testId="stat-live" />
        <StatCard
          label="Pending approvals"
          value={String(stats.awaitingApproval)}
          tone={stats.awaitingApproval > 0 ? 'attention' : 'plain'}
          testId="stat-pending"
        />
        <StatCard label="Suspended shops" value={String(stats.suspended)} testId="stat-suspended" />
        <StatCard label="Payable to shops" value={owed} testId="stat-payable" />
      </div>

      <div className="chart-grid">
        <BarChart
          title="Shops by municipality"
          data={shopsByMunicipality(list)}
          direction="row"
          unit="shops"
        />
        <BarChart
          title="New shops per month"
          data={signupsPerMonth(list, new Date())}
          direction="column"
          unit="sign-ups"
        />
      </div>

      <div className="card">
        <div className="card-head">
          <h2 className="card-title">Waiting for approval</h2>
          <a className="link" href="#/onboarding">
            Review in Onboarding
          </a>
        </div>
        {queue.length === 0 ? (
          <p className="muted">No shop is waiting for approval.</p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Shop</th>
                  <th scope="col">Municipality</th>
                  <th scope="col">Signed up</th>
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                {queue.map((vendor) => (
                  <tr key={vendor.id}>
                    <td>{vendor.business_name}</td>
                    <td>{vendor.municipality_palika_string}</td>
                    <td>{formatDateTime(vendor.created_at)}</td>
                    <td>
                      <span className="status-pill pending">Verification pending</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}
