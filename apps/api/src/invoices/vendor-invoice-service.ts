import { invoiceAccessLog, invoices, vendors, type Database } from '@hamro-pasal/db';
import {
  VENDOR_INVOICE_DEFAULT_LIMIT,
  type AuditActor,
  type AuditContext,
  type VendorInvoiceListQuery,
} from '@hamro-pasal/shared-types';
import { and, desc, eq, sql } from 'drizzle-orm';

import { VendorAccountNotFoundError } from '../orders/vendor-order-service';
import {
  DEFAULT_INVOICE_FONT_DIR,
  InvoiceFontUnavailableError,
  type InvoiceFonts,
} from './invoice-fonts';
import { renderInvoicePdf } from './invoice-pdf';

export type InvoiceRow = typeof invoices.$inferSelect;

/** Unknown, or another shop's: the two are not told apart. */
export class InvoiceNotFoundError extends Error {
  constructor(readonly invoiceId: string) {
    super(`Invoice ${invoiceId} not found`);
    this.name = 'InvoiceNotFoundError';
  }
}

/** The `cursor` is not an invoice of this shop. */
export class InvalidInvoiceCursorError extends Error {
  constructor(readonly cursor: string) {
    super(`Cursor ${cursor} is not an invoice of this shop`);
    this.name = 'InvalidInvoiceCursorError';
  }
}

export interface ListedInvoice {
  readonly invoice: InvoiceRow;
  readonly printCount: number;
}

export interface PrintedInvoice {
  readonly invoice: InvoiceRow;
  /** 0: the original. n: "Copy of Original (n)". */
  readonly copyNumber: number;
  readonly pdf: Buffer;
}

// The outer column is written out: in a single-table select Drizzle renders `${invoices.id}` as
// a bare "id", which inside the subquery would be the log row's own id.
const PRINTS_OF_INVOICE = sql<number>`(
  SELECT count(*)::int FROM invoice_access_log l
  WHERE l.invoice_id = "invoices"."id" AND l.action = 'PRINT')`;

/**
 * A shop's fiscal invoices (Phase 32, SPEC core 10): its list, and the printed document.
 *
 * Every statement carries the caller's vendor id, so another shop's invoice is not found. Nothing
 * here writes `invoices`: the rows are sealed (migration 0029).
 */
export class VendorInvoiceService {
  constructor(
    private readonly db: Database,
    /** The Devanagari font of the printed invoice; null when its file is not installed. */
    private readonly fonts: InvoiceFonts | null = null,
    /**
     * Refuse to print without the Devanagari font (production): an invoice whose Nepali names
     * print as "?" is not an IRD document. Development prints Latin text only.
     */
    private readonly requireDevanagariFont = false,
  ) {}

  /** Newest first, keyset on (issued_at, id). The list itself is not logged. */
  async list(
    vendorUserId: string,
    query: VendorInvoiceListQuery,
  ): Promise<{ invoices: ListedInvoice[]; nextCursor: string | null }> {
    const vendorId = await this.vendorIdOf(vendorUserId);
    const limit = query.limit ?? VENDOR_INVOICE_DEFAULT_LIMIT;
    if (query.cursor !== undefined) {
      const [known] = await this.db
        .select({ id: invoices.id })
        .from(invoices)
        .where(and(eq(invoices.id, query.cursor), eq(invoices.vendor_id, vendorId)));
      if (known === undefined) throw new InvalidInvoiceCursorError(query.cursor);
    }
    const rows = await this.db
      .select({ invoice: invoices, printCount: PRINTS_OF_INVOICE })
      .from(invoices)
      .where(
        and(
          eq(invoices.vendor_id, vendorId),
          query.fiscal_year === undefined ? undefined : eq(invoices.fiscal_year, query.fiscal_year),
          query.document_type === undefined
            ? undefined
            : eq(invoices.document_type, query.document_type),
          // Compared in SQL, so the microseconds of issued_at never pass through JavaScript.
          query.cursor === undefined
            ? undefined
            : sql`(${invoices.issued_at}, ${invoices.id}) <
                (SELECT c.issued_at, c.id FROM invoices c WHERE c.id = ${query.cursor})`,
        ),
      )
      .orderBy(desc(invoices.issued_at), desc(invoices.id))
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    return {
      invoices: page,
      nextCursor: rows.length > limit ? (page.at(-1)?.invoice.id ?? null) : null,
    };
  }

  /**
   * One print of an invoice: its copy number, its access log row and the PDF, in one transaction.
   *
   * The invoice row is locked `FOR UPDATE` (a lock, not a write: the row stays sealed), so two
   * simultaneous prints queue and get consecutive copy numbers; exactly one is the original. The
   * PDF is rendered before the commit: a print that cannot be rendered takes no number.
   *
   * It locks the invoice row and nothing else.
   */
  print(
    actor: AuditActor & { kind: 'USER' },
    invoiceId: string,
    context: AuditContext,
  ): Promise<PrintedInvoice> {
    // Before anything is locked or logged: a print that cannot be made takes no copy number.
    if (this.fonts === null && this.requireDevanagariFont) {
      return Promise.reject(new InvoiceFontUnavailableError(DEFAULT_INVOICE_FONT_DIR));
    }
    return this.db.transaction(async (tx) => {
      const [invoice] = await tx
        .select({ invoice: invoices })
        .from(invoices)
        .innerJoin(vendors, eq(vendors.id, invoices.vendor_id))
        .where(and(eq(invoices.id, invoiceId), eq(vendors.user_id, actor.user_id)))
        .for('update', { of: invoices });
      if (invoice === undefined) throw new InvoiceNotFoundError(invoiceId);

      const [prints] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(invoiceAccessLog)
        .where(
          and(eq(invoiceAccessLog.invoice_id, invoiceId), eq(invoiceAccessLog.action, 'PRINT')),
        );
      const copyNumber = prints?.count ?? 0;
      await tx.insert(invoiceAccessLog).values({
        invoice_id: invoiceId,
        user_id: actor.user_id,
        actor_role: actor.role,
        action: 'PRINT',
        copy_number: copyNumber,
        ip_address: context.ip_address,
        user_agent: context.user_agent,
      });
      const pdf = await renderInvoicePdf(invoice.invoice, copyNumber, { fonts: this.fonts });
      return { invoice: invoice.invoice, copyNumber, pdf };
    });
  }

  private async vendorIdOf(vendorUserId: string): Promise<string> {
    const [vendor] = await this.db
      .select({ id: vendors.id })
      .from(vendors)
      .where(eq(vendors.user_id, vendorUserId));
    if (vendor === undefined) throw new VendorAccountNotFoundError(vendorUserId);
    return vendor.id;
  }
}
