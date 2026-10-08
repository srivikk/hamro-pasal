import { useInfiniteQuery } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState } from 'react';

import { useAdminApi } from '../../app-context';
import { formatDateTime } from '../../lib/format';
import {
  actionLabel,
  actorLabel,
  auditEntriesOf,
  auditFilterOptions,
  auditLoadErrorMessage,
  auditQueryOf,
  auditRows,
  diffSummary,
  NO_AUDIT_FILTERS,
  rawState,
  stateDiff,
  visibleDiff,
  type AuditFilters,
  type AuditLogView,
} from './audit-rules';

const AUDIT_KEY = ['admin', 'audit-logs'] as const;

/**
 * The audit log (SPEC core section 7, "Audit"): who changed what and when, with the state before
 * and after. Strictly read only: this screen has no action that writes, and the table is
 * append-only in the database.
 *
 * The action and record type filters are sent to GET /api/admin/audit-logs (so they reach entries
 * not loaded yet) and the list pages with its `next_cursor`. The search box narrows the entries
 * already loaded: the route has no text search.
 */
export function AuditLogScreen() {
  const api = useAdminApi();
  const [filters, setFilters] = useState<AuditFilters>(NO_AUDIT_FILTERS);
  const [open, setOpen] = useState<AuditLogView | null>(null);

  // What is asked of the server; an unusable filter falls back to no filter.
  const serverQuery = auditQueryOf(filters) ?? {};
  const action = serverQuery.action;
  const entityType = serverQuery.entity_type;

  const list = useInfiniteQuery({
    queryKey: [...AUDIT_KEY, action ?? '', entityType ?? ''],
    queryFn: ({ pageParam }) => api.listAuditLogs({ action, entityType, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.next_cursor ?? undefined,
  });

  const entries = auditEntriesOf(list.data?.pages ?? []);
  const rows = auditRows(entries, {
    ...filters,
    action: action ?? '',
    entityType: entityType ?? '',
  });

  return (
    <section>
      <div className="section-head">
        <div>
          <h2>Audit log</h2>
          <p className="muted">
            {entries.length} entries loaded{list.hasNextPage ? ', more below' : ''}, newest first.
            Every entry was written in the same transaction as the change it records, and can never
            be edited or deleted. Times are Nepal Time.
          </p>
        </div>
        <button
          type="button"
          className="button"
          disabled={list.isFetching}
          onClick={() => void list.refetch()}
        >
          {list.isFetching ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      <div className="filters">
        <select
          className="search filter-select"
          aria-label="Action"
          value={filters.action}
          onChange={(event) => {
            setFilters((current) => ({ ...current, action: event.target.value }));
          }}
        >
          <option value="">All actions</option>
          {auditFilterOptions(entries, 'action').map((action) => (
            <option key={action} value={action}>
              {actionLabel(action)}
            </option>
          ))}
        </select>
        <select
          className="search filter-select"
          aria-label="Record type"
          value={filters.entityType}
          onChange={(event) => {
            setFilters((current) => ({ ...current, entityType: event.target.value }));
          }}
        >
          <option value="">All record types</option>
          {auditFilterOptions(entries, 'entity_type').map((type) => (
            <option key={type} value={type}>
              {type}
            </option>
          ))}
        </select>
        <input
          className="search filter-select"
          type="search"
          placeholder="Search loaded entries: actor or shop"
          aria-label="Search loaded entries by actor or shop"
          value={filters.search}
          onChange={(event) => {
            setFilters((current) => ({ ...current, search: event.target.value }));
          }}
        />
      </div>

      {list.isPending ? (
        <p className="muted">Loading…</p>
      ) : list.isError && entries.length === 0 ? (
        <p className="error" role="alert">
          {auditLoadErrorMessage(list.error)}{' '}
          <button type="button" className="link" onClick={() => void list.refetch()}>
            Try again
          </button>
        </p>
      ) : rows.length === 0 ? (
        <p className="empty">
          {entries.length === 0 ? 'No entries match.' : 'No loaded entry matches the search.'}
        </p>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Timestamp</th>
                <th scope="col">Actor</th>
                <th scope="col">Action</th>
                <th scope="col">Shop</th>
                <th scope="col">
                  <span className="visually-hidden">Details</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((entry) => (
                <tr key={entry.id}>
                  <td className="mono">{formatDateTime(entry.occurred_at)}</td>
                  <td>{actorLabel(entry)}</td>
                  <td>
                    <span className="mono">{entry.action}</span>
                    <div className="muted small">{entry.entity_type}</div>
                  </td>
                  <td>{entry.vendor_name ?? <span className="muted">Platform</span>}</td>
                  <td>
                    <button
                      type="button"
                      className="button"
                      onClick={() => {
                        setOpen(entry);
                      }}
                    >
                      Details
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {list.isFetchNextPageError && (
        <p className="error" role="alert">
          {auditLoadErrorMessage(list.error)}
        </p>
      )}
      {list.hasNextPage && (
        <button
          type="button"
          className="button"
          disabled={list.isFetchingNextPage}
          onClick={() => void list.fetchNextPage()}
        >
          {list.isFetchingNextPage ? 'Loading…' : 'Load older'}
        </button>
      )}

      {open !== null && (
        <AuditDetailsModal
          key={open.id}
          entry={open}
          onClose={() => {
            setOpen(null);
          }}
        />
      )}
    </section>
  );
}

function AuditDetailsModal({
  entry,
  onClose,
}: {
  readonly entry: AuditLogView;
  readonly onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [showUnchanged, setShowUnchanged] = useState(false);

  // A native modal dialog: focus is trapped inside it and Escape closes it.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog !== null && !dialog.open) dialog.showModal();
  }, []);

  const diff = stateDiff(entry.before_state, entry.after_state);
  const shown = visibleDiff(diff, showUnchanged);

  return (
    <dialog
      ref={dialogRef}
      className="modal modal-audit"
      aria-labelledby={titleId}
      onClose={onClose}
    >
      <h2 id={titleId} className="mono">
        {entry.action}
      </h2>

      <dl className="facts">
        <div>
          <dt>When (Nepal Time)</dt>
          <dd>{formatDateTime(entry.occurred_at)}</dd>
        </div>
        <div>
          <dt>Actor</dt>
          <dd>{actorLabel(entry)}</dd>
        </div>
        <div>
          <dt>Shop</dt>
          <dd>{entry.vendor_name ?? 'Platform'}</dd>
        </div>
        <div>
          <dt>Record</dt>
          <dd className="mono">
            {entry.entity_type} {entry.entity_id}
          </dd>
        </div>
        <div>
          <dt>Request</dt>
          <dd className="mono">{entry.request_id ?? 'not recorded'}</dd>
        </div>
        <div>
          <dt>Address</dt>
          <dd className="mono">{entry.ip_address ?? 'not recorded'}</dd>
        </div>
      </dl>

      <div className="diff-head">
        <strong>
          {entry.before_state === null ? 'Created · ' : ''}
          {diffSummary(diff)}
        </strong>
        <label className="check">
          <input
            type="checkbox"
            checked={showUnchanged}
            onChange={(event) => {
              setShowUnchanged(event.target.checked);
            }}
          />
          Show unchanged fields
        </label>
      </div>

      {shown.length === 0 ? (
        <p className="muted">No field differs between the two states.</p>
      ) : (
        <div className="table-wrap">
          <table className="table diff">
            <thead>
              <tr>
                <th scope="col">Field</th>
                <th scope="col">Before</th>
                <th scope="col">After</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((row) => (
                <tr key={row.path} className={`diff-${row.kind.toLowerCase()}`}>
                  <th scope="row" className="mono">
                    {row.path}
                    <span className="visually-hidden"> ({row.kind.toLowerCase()})</span>
                  </th>
                  <td className="mono diff-before">{row.before ?? '—'}</td>
                  <td className="mono diff-after">{row.after ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <details className="message">
        <summary>Raw JSON, as stored</summary>
        <div className="field-pair raw-states">
          <div>
            <span className="muted small">before_state</span>
            <pre>{rawState(entry.before_state)}</pre>
          </div>
          <div>
            <span className="muted small">after_state</span>
            <pre>{rawState(entry.after_state)}</pre>
          </div>
        </div>
      </details>

      <div className="modal-actions">
        <button type="button" className="button primary" onClick={onClose}>
          Close
        </button>
      </div>
    </dialog>
  );
}
