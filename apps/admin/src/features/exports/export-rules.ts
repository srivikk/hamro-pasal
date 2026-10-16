import type { adminExportKinds } from '@hamro-pasal/shared-types';
import {
  adminExportRequestSchema,
  EXPORT_INLINE_ROW_LIMIT,
  EXPORT_LINK_TTL_DAYS,
  type AdminExportRequest,
  type ExportJobView,
} from '@hamro-pasal/shared-types';

import { ApiError } from '../../api/client';

/* Step 7.6 (SPEC core 11): the Exports tab's rules, kept out of the screen so they are tested. */

export type AdminExportKind = (typeof adminExportKinds)[number];

export const EXPORT_KIND_LABELS: Readonly<Record<AdminExportKind, string>> = {
  VENDORS: 'Vendors',
  CUSTOMERS: 'Customers (personal data)',
  ORDERS: 'Orders',
  PAYOUTS: 'Payouts',
  AUDIT_LOG: 'Audit log',
};

/** The kinds that take a shop filter. */
export const KINDS_WITH_VENDOR_FILTER: ReadonlySet<AdminExportKind> = new Set([
  'ORDERS',
  'PAYOUTS',
  'AUDIT_LOG',
]);

export interface ExportDraft {
  readonly kind: AdminExportKind;
  readonly from: string;
  readonly to: string;
  /** Blank for every shop. */
  readonly vendorId: string;
}

export type ExportDraftResult =
  | { readonly ok: true; readonly request: AdminExportRequest }
  | { readonly ok: false; readonly error: string };

export function validateExportDraft(draft: ExportDraft): ExportDraftResult {
  const vendorId = draft.vendorId.trim();
  const parsed = adminExportRequestSchema.safeParse({
    kind: draft.kind,
    from: draft.from,
    to: draft.to,
    ...(vendorId !== '' && KINDS_WITH_VENDOR_FILTER.has(draft.kind) ? { vendor_id: vendorId } : {}),
  });
  if (parsed.success) return { ok: true, request: parsed.data };
  const fields = new Set(parsed.error.issues.map((issue) => String(issue.path[0])));
  if (fields.has('vendor_id')) return { ok: false, error: 'The shop filter must be a vendor id.' };
  if (fields.has('from') || fields.has('to')) {
    return { ok: false, error: 'Choose a date range of at most a year, the start before the end.' };
  }
  return { ok: false, error: 'The export cannot be requested as set.' };
}

/** What the screen says after a request. */
export function queuedText(job: Pick<ExportJobView, 'row_count'>): string {
  return (
    `${String(job.row_count)} rows: more than ${String(EXPORT_INLINE_ROW_LIMIT)}, so the export is ` +
    `being built and will be emailed to you (attached if small, otherwise a link valid for ` +
    `${String(EXPORT_LINK_TTL_DAYS)} days).`
  );
}

export function exportErrorMessage(error: unknown): string {
  if (!(error instanceof ApiError)) return 'The export could not be made.';
  switch (error.code) {
    case 'EMAIL_REQUIRED':
      return `More than ${String(EXPORT_INLINE_ROW_LIMIT)} rows are emailed: add an email address to your account first.`;
    case 'NETWORK_ERROR':
      return 'The API cannot be reached.';
    case 'VALIDATION_FAILED':
      return 'The export was refused as set. Check the dates and the shop filter.';
    default:
      return 'The export could not be made.';
  }
}
