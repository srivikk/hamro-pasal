import type { vendors } from '@hamro-pasal/db';
import {
  enqueueDomainEvent,
  invoices,
  orders,
  recordAuditLog,
  type Transaction,
} from '@hamro-pasal/db';
import { generateFiscalInvoice, InvoiceNotIssuableError } from '@hamro-pasal/ledger';
import type { AuditActor, AuditContext, VendorStatus } from '@hamro-pasal/shared-types';
import { and, asc, eq, notExists, sql } from 'drizzle-orm';

/*
 * The compliance standing of a shop (SPEC core 10, "PAN verification", amended 2026-10-20): a shop
 * trades only on a PAN a Super Admin has verified. The vendor's own actions (saving a PAN,
 * uploading its document) can only take a shop offline; the verification is what brings it back,
 * and what issues the invoices that waited for a verified seller.
 */

export type VendorRow = typeof vendors.$inferSelect;

/**
 * The shop's DELIVERED orders that have no invoice, in the order they were delivered, each row
 * locked FOR UPDATE. WAIT queues behind whoever holds one; SKIP leaves such an order out.
 */
export function waitingOrders(tx: Transaction, vendorId: string, locked: 'WAIT' | 'SKIP') {
  return tx
    .select()
    .from(orders)
    .where(
      and(
        eq(orders.vendor_id, vendorId),
        eq(orders.state, 'DELIVERED'),
        notExists(
          tx
            .select({ one: sql`1` })
            .from(invoices)
            .where(and(eq(invoices.order_id, orders.id), eq(invoices.document_type, 'INVOICE'))),
        ),
      ),
    )
    .orderBy(asc(orders.delivered_at), asc(orders.id))
    .for('update', locked === 'SKIP' ? { skipLocked: true } : {});
}

/**
 * Issues the invoices that waited for the shop's verified PAN (SPEC core 10: an invoice names a
 * checked seller), oldest delivery first, so the Bill Numbers follow the deliveries. They are dated
 * and numbered now: no valid invoice could exist before the seller's PAN was verified.
 *
 * An order whose invoice cannot be issued (its lines do not add up to what the customer paid) is
 * left without one and named in the audit entry: it must not block the verification. Nothing is
 * half-written for it: generateFiscalInvoice refuses before it takes a number.
 */
export async function issueWaitingInvoices(
  tx: Transaction,
  actor: AuditActor,
  vendor: VendorRow,
  context: AuditContext,
): Promise<number> {
  const issued: string[] = [];
  const refused: string[] = [];
  for (const order of await waitingOrders(tx, vendor.id, 'SKIP')) {
    try {
      const result = await generateFiscalInvoice(tx, order);
      if (result.status === 'ISSUED') issued.push(result.invoice.invoice_sequence);
    } catch (error) {
      if (!(error instanceof InvoiceNotIssuableError)) throw error;
      refused.push(order.id);
    }
  }
  if (issued.length === 0 && refused.length === 0) return 0;
  await recordAuditLog(tx, {
    actor,
    action: 'WAITING_INVOICES_ISSUED',
    entityId: vendor.id,
    vendorId: vendor.id,
    beforeState: null,
    afterState: {
      issued_count: issued.length,
      first_invoice_sequence: issued[0] ?? null,
      last_invoice_sequence: issued.at(-1) ?? null,
      refused_order_ids: refused,
    },
    context,
  });
  return issued.length;
}

export interface Standing {
  readonly lifted: boolean;
  readonly columns: {
    readonly status: VendorStatus;
    readonly status_before_compliance_suspension: null;
    readonly status_before_debt_suspension: VendorRow['status_before_debt_suspension'];
    readonly status_before_admin_suspension: VendorRow['status_before_admin_suspension'];
  };
}

/**
 * The shop's standing once its PAN is verified.
 *
 * - SUSPENDED_COMPLIANCE returns to the status it remembered.
 * - A shop whose compliance suspension lies under a debt or admin suspension stays SUSPENDED (the
 *   verification never lifts those), but that suspension must no longer restore it to
 *   SUSPENDED_COMPLIANCE: the remembered status is rewritten to the one the compliance suspension
 *   remembered.
 * - Any other shop keeps its standing.
 */
export function standingWithVerifiedPan(vendor: VendorRow): Standing {
  const restoreTo = vendor.status_before_compliance_suspension;
  const untouched = {
    status: vendor.status,
    status_before_compliance_suspension: null,
    status_before_debt_suspension: vendor.status_before_debt_suspension,
    status_before_admin_suspension: vendor.status_before_admin_suspension,
  };
  if (restoreTo === null) return { lifted: false, columns: untouched };
  if (vendor.status === 'SUSPENDED_COMPLIANCE') {
    return { lifted: true, columns: { ...untouched, status: restoreTo } };
  }
  return {
    lifted: true,
    columns: {
      ...untouched,
      status_before_debt_suspension:
        vendor.status_before_debt_suspension === 'SUSPENDED_COMPLIANCE'
          ? restoreTo
          : vendor.status_before_debt_suspension,
      status_before_admin_suspension:
        vendor.status_before_admin_suspension === 'SUSPENDED_COMPLIANCE'
          ? restoreTo
          : vendor.status_before_admin_suspension,
    },
  };
}

/** Why a LIVE shop lost its verification, for the audit entry. */
export type VerificationLossReason = 'PAN_CHANGED' | 'PAN_DOCUMENT_REPLACED';

/**
 * Takes a LIVE shop offline in the caller's transaction, under the vendor row lock it already
 * holds: SUSPENDED_COMPLIANCE remembering LIVE, audited, with `vendor.suspended_for_compliance`
 * written to the outbox in the same commit. Returns the columns to write, or null for a shop that
 * is not LIVE (it is not trading, and every path back to LIVE checks the verification).
 */
export async function suspendForCompliance(
  tx: Transaction,
  vendor: VendorRow,
  actor: AuditActor,
  reason: VerificationLossReason,
  context: AuditContext,
): Promise<{ status: 'SUSPENDED_COMPLIANCE'; status_before_compliance_suspension: 'LIVE' } | null> {
  if (vendor.status !== 'LIVE') return null;
  await recordAuditLog(tx, {
    actor,
    action: 'VENDOR_SUSPENDED_FOR_COMPLIANCE',
    entityId: vendor.id,
    vendorId: vendor.id,
    beforeState: { status: 'LIVE', tax_id: vendor.tax_id },
    afterState: { status: 'SUSPENDED_COMPLIANCE', restores_to: 'LIVE', reason },
    context,
  });
  const suspendedAt = new Date();
  await enqueueDomainEvent(tx, {
    type: 'vendor.suspended_for_compliance',
    aggregateId: vendor.id,
    occurredAt: suspendedAt,
    payload: {
      vendor_id: vendor.id,
      vendor_phone: vendor.phone,
      previous_status: 'LIVE',
      suspended_at: suspendedAt.toISOString(),
    },
  });
  return { status: 'SUSPENDED_COMPLIANCE', status_before_compliance_suspension: 'LIVE' };
}
