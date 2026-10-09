import {
  auditLogs,
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
   * never lands on a PAN that was replaced first), with its audit entry. A repeat keeps the first
   * stamp and records nothing.
   */
  verifyPan(
    adminUserId: string,
    vendorId: string,
    context: AuditContext = NO_AUDIT_CONTEXT,
  ): Promise<ComplianceVendor> {
    return this.db.transaction(async (tx) => {
      const [before] = await tx
        .select()
        .from(vendors)
        .where(eq(vendors.id, vendorId))
        .for('update');
      if (before === undefined) throw new AdminVendorNotFoundError(vendorId);
      if (before.tax_id === null) throw new PanMissingError(vendorId);
      if (before.pan_verified_at !== null) return complianceVendor(tx, before);

      const [after] = await tx
        .update(vendors)
        .set({ pan_verified_at: sql`now()`, pan_verified_by_user_id: adminUserId })
        .where(eq(vendors.id, vendorId))
        .returning();
      if (after === undefined) throw new Error(`Vendor ${vendorId} vanished`);

      await recordAuditLog(tx, {
        actor: { kind: 'USER', user_id: adminUserId, role: 'SUPER_ADMIN' },
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
        },
        context,
      });
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
