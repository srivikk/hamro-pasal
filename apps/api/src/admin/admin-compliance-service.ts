import {
  auditLogs,
  enqueueDomainEvent,
  recordAuditLog,
  vendors,
  type Database,
  type Transaction,
} from '@hamro-pasal/db';
import {
  ADMIN_VENDOR_LIST_LIMIT,
  NO_AUDIT_CONTEXT,
  type AuditContext,
} from '@hamro-pasal/shared-types';
import { and, asc, eq, sql } from 'drizzle-orm';

import type { KycDocumentStorage, StoredDocument } from '../uploads/kyc-document-storage';
import {
  issueWaitingInvoices,
  standingWithVerifiedPan,
  waitingOrders,
} from '../vendor/compliance-standing';
import { AdminVendorNotFoundError } from '../wallet/wallet-service';

type VendorRow = typeof vendors.$inferSelect;

export interface ComplianceVendor {
  readonly vendor: VendorRow;
  /** When the compliance sweep suspended the shop; null when no such suspension is in force. */
  readonly complianceSuspendedAt: Date | null;
}

/** The vendor has saved no PAN: there is nothing to verify. */
export class PanMissingError extends Error {
  constructor(readonly vendorId: string) {
    super(`Vendor ${vendorId} has no PAN on file`);
    this.name = 'PanMissingError';
  }
}

/**
 * Phase 35: the vendor has a PAN but uploaded no document for it. A Super Admin verifies a
 * document, never a bare number, so there is nothing to verify yet.
 */
export class PanDocumentMissingError extends Error {
  constructor(readonly vendorId: string) {
    super(`Vendor ${vendorId} has uploaded no PAN document to verify`);
    this.name = 'PanDocumentMissingError';
  }
}

/** The vendor uploaded no PAN document (or its object is gone from the store). */
export class PanDocumentNotFoundError extends Error {
  constructor(readonly vendorId: string) {
    super(`Vendor ${vendorId} has no PAN document on file`);
    this.name = 'PanDocumentNotFoundError';
  }
}

/**
 * The Super Admin's side of PAN compliance (SPEC core section 10, "PAN verification").
 *
 * Verifying a PAN gates payouts, never trading: it does not touch `status`. It cannot lift a
 * compliance suspension either; only the transaction that saves the vendor's PAN does
 * (VendorComplianceService), and that same transaction clears this stamp when the PAN changes.
 */
export class AdminComplianceService {
  constructor(
    private readonly db: Database,
    private readonly documents: KycDocumentStorage,
  ) {}

  /**
   * The vendor's uploaded PAN document, for the Super Admin's check (Phase 34). The bucket is
   * private: this read, behind the admin's token, is the only way to the bytes.
   */
  async panDocument(vendorId: string): Promise<StoredDocument> {
    const [vendor] = await this.db
      .select({ key: vendors.pan_document_url })
      .from(vendors)
      .where(eq(vendors.id, vendorId));
    if (vendor === undefined) throw new AdminVendorNotFoundError(vendorId);
    if (vendor.key === null) throw new PanDocumentNotFoundError(vendorId);
    const document = await this.documents.read(vendor.key);
    if (document === null) {
      // The row names an object the store does not have: never expected (see uploadPanDocument).
      console.error(
        JSON.stringify({ storage: 'missing_object', kind: 'pan_document', vendor_id: vendorId }),
      );
      throw new PanDocumentNotFoundError(vendorId);
    }
    return document;
  }

  /**
   * Every vendor with its PAN on file and when a compliance suspension began, by business name
   * (the route groups them by PAN standing). One statement, so one snapshot.
   */
  list(): Promise<ComplianceVendor[]> {
    return this.db
      .select({
        vendor: vendors,
        // The sweep's own audit entry: the table has no column for the suspension time.
        complianceSuspendedAt: sql<Date | null>`CASE
            WHEN "vendors"."status_before_compliance_suspension" IS NULL THEN NULL
            ELSE (SELECT max(a.occurred_at) FROM audit_logs a
                  WHERE a.entity_type = 'vendor' AND a.entity_id = "vendors"."id"
                    AND a.action = 'VENDOR_SUSPENDED_FOR_COMPLIANCE')
          END`.mapWith(auditLogs.occurred_at),
      })
      .from(vendors)
      .orderBy(asc(vendors.business_name), asc(vendors.id))
      .limit(ADMIN_VENDOR_LIST_LIMIT);
  }

  /**
   * One transaction under the vendor row lock (the lock a PAN change takes, so a verification
   * never lands on a PAN or a document that was replaced first), with its audit entries. A repeat
   * keeps the first stamp and records nothing.
   *
   * Phase 35: a PAN without an uploaded document cannot be verified (422 DOCUMENT_MISSING). The
   * check comes before the repeat: a shop that is marked verified with no document on file (only
   * a seeded one can be) answers the same refusal, never a confirmation.
   *
   * SPEC core 10 (amended 2026-10-20): the verification is what lets a shop trade. In the same
   * transaction it lifts the compliance suspension (the shop returns to the status it remembered),
   * issues the invoices that waited for a verified seller, and writes `vendor.compliance_restored`.
   *
   * Lock order, the one a delivery uses: the waiting orders' rows, then the vendor row, then
   * (inside generateFiscalInvoice) the invoice sequence row, last. The order rows come first
   * because the invoice insert's foreign key reads the order row: taken after the sequence row, it
   * could wait on a transaction (the nightly reconciliation) that holds that order and waits for
   * this shop's vendor or sequence row. An order delivered after that first pass is picked up
   * under the vendor lock with SKIP LOCKED; one skipped there is held by a delivery or
   * reconciliation, which reads the vendor row after this commit and issues the invoice itself.
   */
  verifyPan(
    adminUserId: string,
    vendorId: string,
    context: AuditContext = NO_AUDIT_CONTEXT,
  ): Promise<ComplianceVendor> {
    return this.db.transaction(async (tx) => {
      // Before the vendor lock (see the lock order above). An unverified shop is the only one
      // that can have invoices waiting; reading the stamp unlocked only decides this pass.
      const [shop] = await tx
        .select({ verifiedAt: vendors.pan_verified_at })
        .from(vendors)
        .where(eq(vendors.id, vendorId));
      if (shop?.verifiedAt === null) await waitingOrders(tx, vendorId, 'WAIT');

      const [before] = await tx
        .select()
        .from(vendors)
        .where(eq(vendors.id, vendorId))
        .for('update');
      if (before === undefined) throw new AdminVendorNotFoundError(vendorId);
      if (before.tax_id === null) throw new PanMissingError(vendorId);
      if (before.pan_document_url === null) throw new PanDocumentMissingError(vendorId);
      const standing = standingWithVerifiedPan(before);
      if (before.pan_verified_at !== null && !standing.lifted) return complianceVendor(tx, before);

      const actor = { kind: 'USER', user_id: adminUserId, role: 'SUPER_ADMIN' } as const;
      const [after] = await tx
        .update(vendors)
        .set({
          pan_verified_at: before.pan_verified_at ?? sql`now()`,
          pan_verified_by_user_id: before.pan_verified_by_user_id ?? adminUserId,
          ...standing.columns,
        })
        .where(eq(vendors.id, vendorId))
        .returning();
      if (after === undefined) throw new Error(`Vendor ${vendorId} vanished`);

      await recordAuditLog(tx, {
        actor,
        action: 'PAN_VERIFIED',
        entityId: vendorId,
        vendorId,
        beforeState: {
          tax_id: before.tax_id,
          pan_verified_at: null,
          pan_verified_by_user_id: null,
        },
        afterState: {
          tax_id: after.tax_id,
          pan_verified_at: after.pan_verified_at?.toISOString() ?? null,
          pan_verified_by_user_id: after.pan_verified_by_user_id,
          status: after.status,
          ...(standing.lifted ? { compliance_suspension_lifted: true } : {}),
        },
        context,
      });

      // After the update: the invoices copy the seller as this verification leaves it.
      const waitingInvoicesIssued = await issueWaitingInvoices(tx, actor, after, context);
      // The shop is told it is back (or what still keeps it offline). Last in the transaction, so
      // the event exists exactly when the lift committed.
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
      return complianceVendor(tx, after);
    });
  }
}

/** The suspension time is the sweep's own audit entry: the table has no column for it. */
async function complianceVendor(tx: Transaction, vendor: VendorRow): Promise<ComplianceVendor> {
  if (vendor.status_before_compliance_suspension === null) {
    return { vendor, complianceSuspendedAt: null };
  }
  const [last] = await tx
    .select({ at: sql<Date | null>`max(${auditLogs.occurred_at})`.mapWith(auditLogs.occurred_at) })
    .from(auditLogs)
    .where(
      and(
        eq(auditLogs.entity_type, 'vendor'),
        eq(auditLogs.entity_id, vendor.id),
        eq(auditLogs.action, 'VENDOR_SUSPENDED_FOR_COMPLIANCE'),
      ),
    );
  return { vendor, complianceSuspendedAt: last?.at ?? null };
}
