import {
  enqueueDomainEvent,
  invoices,
  orders,
  recordAuditLog,
  vendors,
  type Database,
  type Transaction,
} from '@hamro-pasal/db';
import { generateFiscalInvoice, InvoiceNotIssuableError } from '@hamro-pasal/ledger';
import type {
  AuditActor,
  AuditContext,
  DisputeEvidenceContentType,
  TaxIdentityRequest,
  VendorStatus,
} from '@hamro-pasal/shared-types';
import { and, asc, eq, notExists, sql } from 'drizzle-orm';

import { VendorAccountNotFoundError } from '../orders/vendor-order-service';
import type { KycDocumentStorage } from '../uploads/kyc-document-storage';

export type VendorRow = typeof vendors.$inferSelect;

export interface TaxIdentityResult {
  readonly vendor: VendorRow;
  /** This save lifted the shop's compliance suspension. */
  readonly complianceSuspensionLifted: boolean;
  /** Invoices this save issued for orders delivered while the shop had no PAN. */
  readonly waitingInvoicesIssued: number;
  /** The PAN number changed, so the document of the old number was removed. */
  readonly panDocumentRemoved: boolean;
}

export interface PanDocumentResult {
  readonly vendor: VendorRow;
  /** The upload took the place of an earlier document (which was then deleted). */
  readonly replaced: boolean;
  /** It replaced the document of a verified PAN: payouts wait for a new check. */
  readonly verificationCleared: boolean;
}

/**
 * The vendor's tax identity (SPEC core section 10, "PAN is mandatory" and "PAN verification").
 *
 * Saving a PAN is the only thing that lifts a compliance suspension, and it does so in the same
 * transaction: no admin route can. Saving a different PAN clears the Super Admin's verification,
 * which freezes the shop's payouts until the new PAN is verified; the shop keeps trading. It also
 * removes the document uploaded for the old number (Phase 35): a document belongs to one PAN, and
 * an admin must never be shown the old certificate beside a new number.
 *
 * The first PAN also issues the invoices that were waiting for it (Phase 32): a shop swept for
 * compliance still delivers its open orders, and those deliveries could name no seller.
 */
export class VendorComplianceService {
  constructor(
    private readonly db: Database,
    private readonly documents: KycDocumentStorage,
  ) {}

  /** What the caller's shop has on file (GET /api/vendor/tax-identity). */
  async taxIdentity(vendorUserId: string): Promise<VendorRow> {
    const [vendor] = await this.db.select().from(vendors).where(eq(vendors.user_id, vendorUserId));
    if (vendor === undefined) throw new VendorAccountNotFoundError(vendorUserId);
    return vendor;
  }

  /**
   * Stores the shop's PAN document (Phase 34) and points `pan_document_url` at it.
   *
   * The object and the row are in two systems, so the order of the three steps is the guarantee:
   *
   * 1. **Put the new object first**, under a key nothing refers to yet.
   * 2. **One transaction** under the vendor row lock: the row now names the new key, with its
   *    audit entry. If it fails, the new object is deleted and the old one was never touched.
   * 3. **Only after the commit**, delete the object the row named before.
   *
   * The row therefore never names a missing object. What can be left behind is an object nothing
   * names (a delete that failed, or a crash between two steps): it is logged, costs storage, and
   * is invisible. Two uploads at once queue on the row lock, and the second deletes the first's.
   *
   * Replacing the document of a verified PAN clears the verification in the same transaction:
   * the Super Admin checked the document that is being deleted, not this one. Payouts wait for
   * the new check; the shop keeps trading (SPEC core 10). A first document clears nothing.
   */
  async uploadPanDocument(
    actor: AuditActor & { kind: 'USER' },
    image: { readonly bytes: Buffer; readonly contentType: DisputeEvidenceContentType },
    context: AuditContext,
  ): Promise<PanDocumentResult> {
    const [shop] = await this.db
      .select({ id: vendors.id })
      .from(vendors)
      .where(eq(vendors.user_id, actor.user_id));
    if (shop === undefined) throw new VendorAccountNotFoundError(actor.user_id);

    const key = await this.documents.savePanDocument(shop.id, image.bytes, image.contentType);
    let saved: { result: PanDocumentResult; previousKey: string | null };
    try {
      saved = await this.db.transaction(async (tx) => {
        const [before] = await tx
          .select()
          .from(vendors)
          .where(eq(vendors.id, shop.id))
          .for('update');
        if (before === undefined) throw new VendorAccountNotFoundError(actor.user_id);
        const replaced = before.pan_document_url !== null;
        const verificationCleared = replaced && before.pan_verified_at !== null;

        const [after] = await tx
          .update(vendors)
          .set({
            pan_document_url: key,
            ...(verificationCleared
              ? { pan_verified_at: null, pan_verified_by_user_id: null }
              : {}),
          })
          .where(eq(vendors.id, before.id))
          .returning();
        if (after === undefined) throw new Error(`Vendor ${before.id} vanished`);

        await recordAuditLog(tx, {
          actor,
          action: 'PAN_DOCUMENT_UPLOADED',
          entityId: before.id,
          vendorId: before.id,
          beforeState: { pan_document_url: before.pan_document_url },
          afterState: { pan_document_url: key, size_bytes: image.bytes.length },
          context,
        });
        if (verificationCleared) {
          await recordAuditLog(tx, {
            actor,
            action: 'PAN_VERIFICATION_CLEARED',
            entityId: before.id,
            vendorId: before.id,
            beforeState: {
              tax_id: before.tax_id,
              pan_verified_at: before.pan_verified_at?.toISOString() ?? null,
              pan_verified_by_user_id: before.pan_verified_by_user_id,
            },
            afterState: {
              tax_id: after.tax_id,
              pan_verified_at: null,
              pan_verified_by_user_id: null,
              reason: 'PAN_DOCUMENT_REPLACED',
            },
            context,
          });
        }
        return {
          result: { vendor: after, replaced, verificationCleared },
          previousKey: before.pan_document_url,
        };
      });
    } catch (error: unknown) {
      await this.discard(key);
      throw error;
    }
    if (saved.previousKey !== null) await this.discard(saved.previousKey);
    return saved.result;
  }

  /** Deletes an object nothing names any more. Never throws: the request's outcome stands. */
  private async discard(key: string): Promise<void> {
    try {
      await this.documents.deleteFile(key);
    } catch (error: unknown) {
      console.warn(
        JSON.stringify({
          storage: 'orphan_object',
          kind: 'pan_document',
          key,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }

  /**
   * One transaction under the vendor row lock (the lock every wallet journal and admin override
   * takes), with its audit entries. A repeat with the same values changes and records nothing.
   *
   * Lock order, the one a delivery uses: the waiting orders' rows, then the vendor row, then
   * (inside generateFiscalInvoice) the invoice sequence row, last.
   *
   * - The order rows come first because the invoice insert's foreign key reads the order row:
   *   taken after the sequence row, it could wait on a transaction (the nightly reconciliation)
   *   that holds that order and waits for this shop's vendor or sequence row.
   * A changed PAN number sets `pan_document_url` to null in this transaction and, only after
   * the commit, deletes the object it named (the order `uploadPanDocument` keeps: a row never
   * names a missing object; a failed delete leaves a logged orphan). An upload racing this save
   * queues on the same vendor row lock, so whichever commits second decides what is on file. A
   * first PAN is not a change: a document uploaded before it is kept.
   *
   * - An order delivered after that first pass is picked up under the vendor lock with SKIP
   *   LOCKED: this transaction never waits for an order row while it holds the vendor row. An
   *   order skipped there is held by a delivery or reconciliation, which reads the vendor row
   *   after this commit, finds the PAN and issues the invoice itself.
   */
  async saveTaxIdentity(
    actor: AuditActor & { kind: 'USER' },
    input: TaxIdentityRequest,
    context: AuditContext,
  ): Promise<TaxIdentityResult> {
    const { result, removedKey } = await this.saveTaxIdentityRow(actor, input, context);
    if (removedKey !== null) await this.discard(removedKey);
    return result;
  }

  private saveTaxIdentityRow(
    actor: AuditActor & { kind: 'USER' },
    input: TaxIdentityRequest,
    context: AuditContext,
  ): Promise<{ result: TaxIdentityResult; removedKey: string | null }> {
    return this.db.transaction(async (tx) => {
      // The account's shop never changes, and a PAN is never removed: both are safe to read
      // before the lock. A shop that already has a PAN has no invoice waiting for one.
      const [shop] = await tx
        .select({ id: vendors.id, tax_id: vendors.tax_id })
        .from(vendors)
        .where(eq(vendors.user_id, actor.user_id));
      if (shop === undefined) throw new VendorAccountNotFoundError(actor.user_id);
      if (shop.tax_id === null) await waitingOrders(tx, shop.id, 'WAIT');

      const [before] = await tx
        .select()
        .from(vendors)
        .where(eq(vendors.user_id, actor.user_id))
        .for('update');
      if (before === undefined) throw new VendorAccountNotFoundError(actor.user_id);

      // A different PAN is a different document: the check of the old one says nothing about it.
      const panChanged = before.tax_id !== null && before.tax_id !== input.tax_id;
      const verificationCleared = before.tax_id !== input.tax_id && before.pan_verified_at !== null;
      // The document on file is the old number's: the matching one must be uploaded.
      const removedKey = panChanged ? before.pan_document_url : null;
      const standing = standingWithPan(before);

      const next = {
        tax_id: input.tax_id,
        is_vat_registered: input.is_vat_registered,
        legal_name: input.legal_name === undefined ? before.legal_name : input.legal_name,
        registered_address:
          input.registered_address === undefined
            ? before.registered_address
            : input.registered_address,
        pan_verified_at: verificationCleared ? null : before.pan_verified_at,
        pan_verified_by_user_id: verificationCleared ? null : before.pan_verified_by_user_id,
        pan_document_url: panChanged ? null : before.pan_document_url,
        ...standing.columns,
      };

      const unchanged =
        before.tax_id === next.tax_id &&
        before.is_vat_registered === next.is_vat_registered &&
        before.legal_name === next.legal_name &&
        before.registered_address === next.registered_address &&
        !standing.lifted;
      if (unchanged) {
        return {
          result: {
            vendor: before,
            complianceSuspensionLifted: false,
            waitingInvoicesIssued: 0,
            panDocumentRemoved: false,
          },
          removedKey: null,
        };
      }

      const [after] = await tx
        .update(vendors)
        .set(next)
        .where(eq(vendors.id, before.id))
        .returning();
      if (after === undefined) throw new Error(`Vendor ${before.id} vanished`);

      await recordAuditLog(tx, {
        actor,
        action: 'TAX_IDENTITY_SAVED',
        entityId: before.id,
        vendorId: before.id,
        beforeState: taxIdentityState(before),
        afterState: taxIdentityState(after),
        context,
      });
      if (verificationCleared) {
        await recordAuditLog(tx, {
          actor,
          action: 'PAN_VERIFICATION_CLEARED',
          entityId: before.id,
          vendorId: before.id,
          beforeState: {
            tax_id: before.tax_id,
            pan_verified_at: before.pan_verified_at?.toISOString() ?? null,
            pan_verified_by_user_id: before.pan_verified_by_user_id,
          },
          afterState: {
            tax_id: after.tax_id,
            pan_verified_at: null,
            pan_verified_by_user_id: null,
          },
          context,
        });
      }

      if (removedKey !== null) {
        await recordAuditLog(tx, {
          actor,
          action: 'PAN_DOCUMENT_REMOVED',
          entityId: before.id,
          vendorId: before.id,
          beforeState: { tax_id: before.tax_id, pan_document_url: removedKey },
          afterState: { tax_id: after.tax_id, pan_document_url: null, reason: 'PAN_CHANGED' },
          context,
        });
      }

      // After the update: the invoices copy the seller's PAN, VAT registration, name and address
      // as this save leaves them.
      const waitingInvoicesIssued =
        before.tax_id === null ? await issueWaitingInvoices(tx, actor, after, context) : 0;
      // Phase 36: the shop is told it is back (or what still keeps it offline). Last in the
      // transaction, so the event exists exactly when the lift committed.
      if (
        standing.lifted &&
        after.status !== 'SUSPENDED_COMPLIANCE' &&
        after.status !== 'DEACTIVATED'
      ) {
        const restoredAt = new Date();
        await enqueueDomainEvent(tx, {
          type: 'vendor.compliance_restored',
          aggregateId: after.id,
          occurredAt: restoredAt,
          payload: {
            vendor_id: after.id,
            vendor_phone: after.phone,
            status: after.status,
            waiting_invoices_issued: waitingInvoicesIssued,
            restored_at: restoredAt.toISOString(),
          },
        });
      }
      return {
        result: {
          vendor: after,
          complianceSuspensionLifted: standing.lifted,
          waitingInvoicesIssued,
          panDocumentRemoved: removedKey !== null,
        },
        removedKey,
      };
    });
  }
}

/**
 * The shop's DELIVERED orders that have no invoice, in the order they were delivered, each row
 * locked FOR UPDATE. WAIT queues behind whoever holds one; SKIP leaves such an order out.
 */
function waitingOrders(tx: Transaction, vendorId: string, locked: 'WAIT' | 'SKIP') {
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
 * Issues the invoices that waited for the shop's PAN (SPEC core 10: "their invoices are issued
 * when the PAN arrives"), oldest delivery first, so the Bill Numbers follow the deliveries. They
 * are dated and numbered now: no invoice could exist before the seller had a PAN to print.
 *
 * An order whose invoice cannot be issued (its lines do not add up to what the customer paid) is
 * left without one and named in the audit entry: it must not keep the shop from saving its PAN.
 * Nothing is half-written for it: generateFiscalInvoice refuses before it takes a number.
 */
async function issueWaitingInvoices(
  tx: Transaction,
  actor: AuditActor & { kind: 'USER' },
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

interface Standing {
  readonly lifted: boolean;
  readonly columns: {
    readonly status: VendorStatus;
    readonly status_before_compliance_suspension: null;
    readonly status_before_debt_suspension: VendorRow['status_before_debt_suspension'];
    readonly status_before_admin_suspension: VendorRow['status_before_admin_suspension'];
  };
}

/**
 * The shop's standing once it has a PAN.
 *
 * - SUSPENDED_COMPLIANCE returns to the status it remembered.
 * - A shop whose compliance suspension lies under a debt or admin suspension stays SUSPENDED (a
 *   PAN never lifts those), but that suspension must no longer restore it to SUSPENDED_COMPLIANCE:
 *   the remembered status is rewritten to the one the compliance suspension remembered.
 * - Any other shop keeps its standing.
 */
function standingWithPan(vendor: VendorRow): Standing {
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

function taxIdentityState(vendor: VendorRow) {
  return {
    tax_id: vendor.tax_id,
    is_vat_registered: vendor.is_vat_registered,
    legal_name: vendor.legal_name,
    registered_address: vendor.registered_address,
    status: vendor.status,
    pan_verified_at: vendor.pan_verified_at?.toISOString() ?? null,
  };
}
