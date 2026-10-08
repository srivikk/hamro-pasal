import {
  ADMIN_AUDIT_LOG_MAX_LIMIT,
  AUDIT_ACTION_ENTITY_TYPES,
  adminAuditLogListQuerySchema,
  auditLogViewSchema,
  type AdminAuditLogListQuery,
  type AuditLogView,
} from '@hamro-pasal/shared-types';
import type { z } from 'zod';

import { ApiError } from '../../api/client';

/**
 * The contract of GET /api/admin/audit-logs lives in `@hamro-pasal/shared-types`
 * (`api/admin-governance.ts`) since the API serves it (Phase 26). Re-exported under the names
 * this screen has always used.
 *
 * READ ONLY. `audit_logs` is append-only in the database (a trigger refuses UPDATE and DELETE),
 * and every row is written by the service that made the change, in that change's transaction.
 * This module therefore has a view schema and a query schema and **no write schema**: there is no
 * request this dashboard could send that creates, edits or removes an entry.
 */
export { auditLogViewSchema };
export type { AuditLogView };

export const AUDIT_LOG_MAX_LIMIT = ADMIN_AUDIT_LOG_MAX_LIMIT;

/** The query of GET /api/admin/audit-logs: filters and keyset paging, newest first. */
export const auditLogQuerySchema = adminAuditLogListQuerySchema;
export type AuditLogQuery = AdminAuditLogListQuery;

/** The screen's filters, as chosen. '' is "all". */
export interface AuditFilters {
  readonly action: string;
  readonly entityType: string;
  readonly search: string;
}

export const NO_AUDIT_FILTERS: AuditFilters = { action: '', entityType: '', search: '' };

/** The server-side part of the filters, checked with the query schema; null when it is not valid. */
export function auditQueryOf(filters: AuditFilters): AuditLogQuery | null {
  const parsed = auditLogQuerySchema.safeParse({
    ...(filters.action === '' ? {} : { action: filters.action }),
    ...(filters.entityType === '' ? {} : { entity_type: filters.entityType }),
  });
  return parsed.success ? parsed.data : null;
}

/** "SETTLEMENT_MODEL_CHANGED" -> "Settlement model changed". */
export function actionLabel(action: string): string {
  const words = action.toLowerCase().replaceAll('_', ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const ROLE_LABELS: Readonly<Record<NonNullable<AuditLogView['actor_role']>, string>> = {
  SUPER_ADMIN: 'Super Admin',
  VENDOR: 'Vendor',
  CUSTOMER: 'Customer',
  DRIVER: 'Rider',
};

/** "Thamel Kirana Pasal (Vendor)" / "Sarita (Super Admin)" / "VENDOR_COMPLIANCE_SWEEP (System)". */
export function actorLabel(entry: Pick<AuditLogView, 'actor_name' | 'actor_role'>): string {
  // No role: the platform's own scheduled job acted, and `actor_name` is the job.
  const role = entry.actor_role === null ? 'System' : ROLE_LABELS[entry.actor_role];
  return `${entry.actor_name} (${role})`;
}

/** The distinct values of a column among the entries, sorted: the options of a filter. */
export function auditOptions(
  entries: readonly AuditLogView[],
  column: 'action' | 'entity_type',
): string[] {
  return [...new Set(entries.map((entry) => entry[column]))].sort();
}

/** The entries the filters keep, newest first. The search matches the actor and the shop. */
export function auditRows(entries: readonly AuditLogView[], filters: AuditFilters): AuditLogView[] {
  const needle = filters.search.trim().toLowerCase();
  return entries
    .filter((entry) => filters.action === '' || entry.action === filters.action)
    .filter((entry) => filters.entityType === '' || entry.entity_type === filters.entityType)
    .filter(
      (entry) =>
        needle === '' ||
        [entry.actor_name, entry.vendor_name ?? ''].some((field) =>
          field.toLowerCase().includes(needle),
        ),
    )
    .sort((a, b) => b.occurred_at.localeCompare(a.occurred_at) || b.id.localeCompare(a.id));
}

export const DIFF_KINDS = ['ADDED', 'REMOVED', 'CHANGED', 'UNCHANGED'] as const;
export type DiffKind = (typeof DIFF_KINDS)[number];

export interface DiffRow {
  /** "terms.vendor_share_percent". */
  readonly path: string;
  readonly kind: DiffKind;
  /** The value as JSON text; null when the field did not exist on that side. */
  readonly before: string | null;
  readonly after: string | null;
}

type Json = z.infer<ReturnType<typeof z.json>>;

function isObject(value: Json | undefined): value is Record<string, Json> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * One leaf per field, nested objects walked by dotted path. An array is one value (a list of
 * payment methods changed as a whole), and so is an empty object.
 */
function leaves(value: Json, prefix: string, into: Map<string, string>): void {
  if (isObject(value) && Object.keys(value).length > 0) {
    for (const [key, child] of Object.entries(value)) {
      leaves(child, prefix === '' ? key : `${prefix}.${key}`, into);
    }
    return;
  }
  into.set(prefix, JSON.stringify(value));
}

/**
 * The field-by-field difference between the state before and after a change, in path order:
 * what was added, removed, changed, and what stayed the same. A creation (`before` null) is all
 * ADDED. Values are compared as JSON text, so 860 and 860.0 are equal and "860" is not.
 */
export function stateDiff(
  before: AuditLogView['before_state'],
  after: AuditLogView['after_state'],
): DiffRow[] {
  const was = new Map<string, string>();
  const is = new Map<string, string>();
  if (before !== null) leaves(before, '', was);
  leaves(after, '', is);
  // An empty state has one leaf at the root path '': it is not a field.
  was.delete('');
  is.delete('');
  return [...new Set([...was.keys(), ...is.keys()])].sort().map((path) => {
    const beforeValue = was.get(path) ?? null;
    const afterValue = is.get(path) ?? null;
    const kind: DiffKind =
      beforeValue === null
        ? 'ADDED'
        : afterValue === null
          ? 'REMOVED'
          : beforeValue === afterValue
            ? 'UNCHANGED'
            : 'CHANGED';
    return { path, kind, before: beforeValue, after: afterValue };
  });
}

/** "3 changed · 1 added · 0 removed". */
export function diffSummary(rows: readonly DiffRow[]): string {
  const count = (kind: DiffKind) => rows.filter((row) => row.kind === kind).length;
  return `${String(count('CHANGED'))} changed · ${String(count('ADDED'))} added · ${String(count('REMOVED'))} removed`;
}

/** The rows the details show: every difference, and the unchanged fields only when asked. */
export function visibleDiff(rows: readonly DiffRow[], showUnchanged: boolean): DiffRow[] {
  return showUnchanged ? [...rows] : rows.filter((row) => row.kind !== 'UNCHANGED');
}

/** A state as indented JSON, exactly as stored, for the raw view. */
export function rawState(state: AuditLogView['before_state']): string {
  return state === null ? 'null (nothing existed before)' : JSON.stringify(state, null, 2);
}

/**
 * The options of a filter: every value the platform can write (the audit contract's own list),
 * plus any other the loaded entries carry. The list does not shrink when a filter is chosen and
 * the server returns only matching entries.
 */
export function auditFilterOptions(
  entries: readonly AuditLogView[],
  column: 'action' | 'entity_type',
): string[] {
  const known =
    column === 'action'
      ? Object.keys(AUDIT_ACTION_ENTITY_TYPES)
      : Object.values(AUDIT_ACTION_ENTITY_TYPES);
  return [...new Set([...known, ...auditOptions(entries, column)])].sort();
}

/** The loaded pages as one list. */
export function auditEntriesOf(
  pages: readonly { readonly entries: readonly AuditLogView[] }[],
): AuditLogView[] {
  return pages.flatMap((page) => page.entries);
}

export function auditLoadErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'NETWORK_ERROR') return 'The API cannot be reached.';
    if (error.code === 'INVALID_CURSOR') return 'The list changed. Refresh to start from the top.';
  }
  return 'The audit log could not be loaded.';
}
