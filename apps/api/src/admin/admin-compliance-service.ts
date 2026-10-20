import {
  auditLogs,
  enqueueDomainEvent,
  irdPanChecks,
  recordAuditLog,
  vendors,
  type Database,
  type Transaction,
} from '@hamro-pasal/db';
import { PanVendorNotFoundError, verifyVendorPan } from '@hamro-pasal/ledger';
import {
  ADMIN_VENDOR_LIST_LIMIT,
  NO_AUDIT_CONTEXT,
  type AuditContext,
} from '@hamro-pasal/shared-types';
import { and, asc, eq, sql } from 'drizzle-orm';

export type IrdCheckRow = typeof irdPanChecks.$inferSelect;

/** One check in the manual-review queue, with the vendor it is about. */
export interface ManualReviewEntry {
  readonly check: IrdCheckRow;
  readonly vendor: VendorRow;
}

/** No IRD check with that id. */
export class IrdCheckNotFoundError extends Error {
  constructor(readonly checkId: string) {
    super(`IRD check ${checkId} not found`);
    this.name = 'IrdCheckNotFoundError';
  }
}

/** Only a check waiting in manual review can be tried again. */
export class IrdCheckNotInReviewError extends Error {
  constructor(
    readonly checkId: string,
    readonly status: string,
  ) {
    super(`IRD check ${checkId} is ${status}, not in manual review`);
    this.name = 'IrdCheckNotInReviewError';
  }
}

import type { KycDocumentStorage, StoredDocument } from '../uploads/kyc-document-storage';
import { AdminVendorNotFoundError } from '../wallet/wallet-service';

type VendorRow = typeof vendors.$inferSelect;

export interface ComplianceVendor {
  readonly vendor: VendorRow;
  /** When the compliance sweep suspended the shop; null when no such suspension is in force. */
  readonly complianceSuspendedAt: Date | null;
}

// The verification transaction and its refusals live in @hamro-pasal/ledger (2026-10-21): the
// automated IRD check runs the same transaction.
export { PanDocumentMissingError, PanMissingError } from '@hamro-pasal/ledger';

/** The vendor uploaded no PAN document (or its object is gone from the store). */
export class PanDocumentNotFoundError extends Error {
  constructor(readonly vendorId: string) {
    super(`Vendor ${vendorId} has no PAN document on file`);
    this.name = 'PanDocumentNotFoundError';
  }
}

/**
 * The Super Admin's side of PAN compliance (SPEC core section 10, "PAN verification"). Since
 * 2026-10-20 the verification is what lets a shop trade; since 2026-10-21 the automated IRD check
 * can make it too, and the checks it cannot settle wait here for a person (AdminKycService).
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
   * A Super Admin verifies the PAN: `verifyVendorPan` in @hamro-pasal/ledger, the transaction the
   * automated IRD check also runs (lift the compliance suspension, issue the waiting invoices,
   * `vendor.compliance_restored`, and close the vendor's open IRD checks). A repeat keeps the
   * first stamp and records nothing; a PAN without a document is refused (422 DOCUMENT_MISSING).
   */
  /**
   * "Action Required: Manual Review" (2026-10-21): every IRD check the worker could not settle,
   * oldest first, with its vendor. A Super Admin then verifies the PAN by hand (which resolves the
   * check) or asks for another try.
   */
  manualReviewQueue(): Promise<ManualReviewEntry[]> {
    return this.db
      .select({ check: irdPanChecks, vendor: vendors })
      .from(irdPanChecks)
      .innerJoin(vendors, eq(vendors.id, irdPanChecks.vendor_id))
      .where(eq(irdPanChecks.status, 'MANUAL_REVIEW'))
      .orderBy(asc(irdPanChecks.created_at), asc(irdPanChecks.id))
      .limit(ADMIN_VENDOR_LIST_LIMIT);
  }

  /**
   * Queues a check in manual review again (after the IRD site came back, say): its attempts start
   * over, under the check row lock, with `vendor.pan_check_requested` and an audit entry in the
   * same transaction. Only a check in MANUAL_REVIEW: anything else is 409.
   */
  retryIrdCheck(
    adminUserId: string,
    checkId: string,
    context: AuditContext = NO_AUDIT_CONTEXT,
  ): Promise<IrdCheckRow> {
    return this.db.transaction(async (tx) => {
      const [before] = await tx
        .select()
        .from(irdPanChecks)
        .where(eq(irdPanChecks.id, checkId))
        .for('update');
      if (before === undefined) throw new IrdCheckNotFoundError(checkId);
      if (before.status !== 'MANUAL_REVIEW') {
        throw new IrdCheckNotInReviewError(checkId, before.status);
      }
      const [after] = await tx
        .update(irdPanChecks)
        .set({
          status: 'QUEUED',
          review_reason: null,
          attempts: 0,
          last_error: null,
          started_at: null,
          completed_at: null,
        })
        .where(eq(irdPanChecks.id, checkId))
        .returning();
      if (after === undefined) throw new Error(`IRD check ${checkId} vanished`);
      await recordAuditLog(tx, {
        actor: { kind: 'USER', user_id: adminUserId, role: 'SUPER_ADMIN' },
        action: 'IRD_PAN_CHECK_RETRIED',
        entityId: checkId,
        vendorId: before.vendor_id,
        beforeState: { status: before.status, review_reason: before.review_reason },
        afterState: { status: 'QUEUED' },
        context,
      });
      const requestedAt = new Date();
      await enqueueDomainEvent(tx, {
        type: 'vendor.pan_check_requested',
        aggregateId: before.vendor_id,
        occurredAt: requestedAt,
        payload: {
          check_id: checkId,
          vendor_id: before.vendor_id,
          tax_id: before.tax_id,
          requested_at: requestedAt.toISOString(),
        },
      });
      return after;
    });
  }

  async verifyPan(
    adminUserId: string,
    vendorId: string,
    context: AuditContext = NO_AUDIT_CONTEXT,
  ): Promise<ComplianceVendor> {
    try {
      const { vendor } = await verifyVendorPan(
        this.db,
        vendorId,
        { kind: 'USER', userId: adminUserId },
        { context },
      );
      return await complianceVendor(this.db, vendor);
    } catch (error: unknown) {
      if (error instanceof PanVendorNotFoundError) throw new AdminVendorNotFoundError(vendorId);
      throw error;
    }
  }
}

/** The suspension time is the sweep's own audit entry: the table has no column for it. */
async function complianceVendor(
  tx: Database | Transaction,
  vendor: VendorRow,
): Promise<ComplianceVendor> {
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
