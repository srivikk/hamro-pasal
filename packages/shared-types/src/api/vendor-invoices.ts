import { z } from 'zod';

import { fiscalDocumentTypeSchema, paymentMethodSchema } from '../domain/enums';

/*
 * A shop's fiscal invoices (Phase 32, SPEC core 10), served under /api/vendor/invoices to the
 * shop's own account. The visual invoice is the server's: GET /api/vendor/invoices/:id/pdf
 * answers a PDF the server rendered from the sealed row (decided 2026-10-08), so no client lays
 * out, relabels or renumbers a printed invoice.
 */

/** What `invoice_access_log` records (SPEC core 10, "View and print tracking"). */
export const invoiceAccessActions = ['VIEW', 'DOWNLOAD', 'PRINT'] as const;
export const invoiceAccessActionSchema = z.enum(invoiceAccessActions);
export type InvoiceAccessAction = z.infer<typeof invoiceAccessActionSchema>;

/** Printed on every invoice (SPEC core 10, "Who issues it"). */
export const INVOICE_PLATFORM_DISCLAIMER = 'Generated via Hamro Pasal on behalf of the seller.';

/**
 * What a print is marked with: the first is the original, every later one a numbered copy
 * (SPEC core 10). `copyNumber` 0 is the original.
 */
export function invoiceCopyLabel(copyNumber: number): string {
  return copyNumber === 0 ? 'ORIGINAL' : `COPY OF ORIGINAL (${String(copyNumber)})`;
}

export const VENDOR_INVOICE_DEFAULT_LIMIT = 20;
export const VENDOR_INVOICE_MAX_LIMIT = 50;

/** GET /api/vendor/invoices?fiscal_year=&document_type=&limit=&cursor=: newest first. */
export const vendorInvoiceListQuerySchema = z.strictObject({
  /** "2082/083". */
  fiscal_year: z
    .string()
    .regex(/^[0-9]{4}\/[0-9]{3}$/, 'A fiscal year is written 2082/083')
    .optional(),
  document_type: fiscalDocumentTypeSchema.optional(),
  limit: z
    .string()
    .trim()
    .regex(/^\d{1,3}$/, 'limit must be a whole number')
    .transform(Number)
    .pipe(z.number().int().min(1).max(VENDOR_INVOICE_MAX_LIMIT))
    .optional(),
  /** The id of the last invoice of the previous page. */
  cursor: z.uuid().optional(),
});
export type VendorInvoiceListQuery = z.output<typeof vendorInvoiceListQuerySchema>;

/** One invoice in the shop's list: the header. The document itself is the PDF. */
export const vendorInvoiceSummarySchema = z.strictObject({
  id: z.uuid(),
  document_type: fiscalDocumentTypeSchema,
  order_id: z.uuid(),
  fiscal_year: z.string(),
  bill_number: z.number().int().min(1),
  /** The number as printed: "HP-2082-000142". */
  invoice_sequence: z.string().min(1),
  issued_at: z.iso.datetime(),
  /** "2082-06-21". */
  issued_date_bs: z.string(),
  buyer_name: z.string().min(1),
  payment_method: paymentMethodSchema,
  grand_total_npr: z.number().min(0),
  /** How often it has been printed: 0 means the next print is the original. */
  print_count: z.number().int().min(0),
});
export type VendorInvoiceSummary = z.infer<typeof vendorInvoiceSummarySchema>;

export const vendorInvoiceListResponseSchema = z.strictObject({
  invoices: z.array(vendorInvoiceSummarySchema),
  next_cursor: z.uuid().nullable(),
});
export type VendorInvoiceListResponseBody = z.infer<typeof vendorInvoiceListResponseSchema>;

/** The copy number of the PDF a print answered with (0 = the original). */
export const INVOICE_COPY_NUMBER_HEADER = 'X-Invoice-Copy-Number';
