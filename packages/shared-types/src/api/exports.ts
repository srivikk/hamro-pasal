import { z } from 'zod';

/*
 * Step 7.6 (SPEC core 11, verification 30): CSV data exports. At most EXPORT_INLINE_ROW_LIMIT
 * rows download at once (`200 text/csv`); a larger export is queued (`202`), built by the worker,
 * zipped and emailed through Amazon SES: attached under 7 MB, else linked (sign-in, 7 days).
 */

/** Rows that download at once; one more and the export is queued and emailed. */
export const EXPORT_INLINE_ROW_LIMIT = 5000;
/** How long the link to a queued export works (decided 2026-10-15). */
export const EXPORT_LINK_TTL_DAYS = 7;
/** The widest date range one export may cover. */
export const EXPORT_MAX_RANGE_DAYS = 366;

export const vendorExportKinds = ['STATEMENT', 'ORDERS', 'INVOICES'] as const;
export const adminExportKinds = ['VENDORS', 'CUSTOMERS', 'ORDERS', 'PAYOUTS', 'AUDIT_LOG'] as const;
/** Every kind, as stored in export_jobs.kind (ORDERS once, for either requester). */
export const exportKinds = [
  'STATEMENT',
  'ORDERS',
  'INVOICES',
  'VENDORS',
  'CUSTOMERS',
  'PAYOUTS',
  'AUDIT_LOG',
] as const;
export const exportKindSchema = z.enum(exportKinds);
export type ExportKind = z.infer<typeof exportKindSchema>;

export const exportJobStatuses = ['QUEUED', 'RUNNING', 'DONE', 'FAILED'] as const;
export const exportJobStatusSchema = z.enum(exportJobStatuses);
export type ExportJobStatus = z.infer<typeof exportJobStatusSchema>;

export const exportDeliveries = ['ATTACHMENT', 'LINK'] as const;
export const exportDeliverySchema = z.enum(exportDeliveries);
export type ExportDelivery = z.infer<typeof exportDeliverySchema>;

const isoDate = z.iso.date();

/** Shared refinements: `from` on or before `to` (Nepal Time, inclusive), at most a year apart. */
function inRange<T extends z.ZodType<{ from: string; to: string }>>(schema: T) {
  return schema
    .refine((body) => body.from <= body.to, { path: ['to'], message: 'to is on or after from' })
    .refine(
      (body) => (Date.parse(body.to) - Date.parse(body.from)) / 86_400_000 <= EXPORT_MAX_RANGE_DAYS,
      { path: ['to'], message: `At most ${String(EXPORT_MAX_RANGE_DAYS)} days` },
    );
}

/** POST /api/vendor/exports: the vendor's own shop, always (the server scopes it). */
export const vendorExportRequestSchema = inRange(
  z.strictObject({ kind: z.enum(vendorExportKinds), from: isoDate, to: isoDate }),
);
export type VendorExportRequest = z.infer<typeof vendorExportRequestSchema>;

/** POST /api/admin/exports. `vendor_id` narrows ORDERS and PAYOUTS to one shop. */
export const adminExportRequestSchema = inRange(
  z.strictObject({
    kind: z.enum(adminExportKinds),
    from: isoDate,
    to: isoDate,
    vendor_id: z.uuid().optional(),
  }),
);
export type AdminExportRequest = z.infer<typeof adminExportRequestSchema>;

/** What an export was asked for, kept on the job (never the data). */
export const exportParamsSchema = z.strictObject({
  from: isoDate,
  to: isoDate,
  /** The shop a vendor export is scoped to, or an admin filter. */
  vendor_id: z.uuid().optional(),
});
export type ExportParams = z.infer<typeof exportParamsSchema>;

/** 202 and GET …/exports/:id. */
export const exportJobViewSchema = z.strictObject({
  id: z.uuid(),
  kind: exportKindSchema,
  status: exportJobStatusSchema,
  row_count: z.number().int().min(0),
  delivery: exportDeliverySchema.nullable(),
  /** Whether GET …/download serves the file now (a linked export, until it expires). */
  downloadable: z.boolean(),
  error: z.string().nullable(),
  created_at: z.iso.datetime(),
  finished_at: z.iso.datetime().nullable(),
  expires_at: z.iso.datetime().nullable(),
});
export type ExportJobView = z.infer<typeof exportJobViewSchema>;

export const exportJobResponseSchema = z.strictObject({ job: exportJobViewSchema });
export type ExportJobResponseBody = z.infer<typeof exportJobResponseSchema>;
