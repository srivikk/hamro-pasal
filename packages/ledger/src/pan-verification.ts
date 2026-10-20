import {
  enqueueDomainEvent,
  irdPanChecks,
  recordAuditLog,
  vendors,
  type Database,
  type Transaction,
} from '@hamro-pasal/db';
import { NO_AUDIT_CONTEXT, type AuditActor, type AuditContext } from '@hamro-pasal/shared-types';
import { and, eq, inArray, sql } from 'drizzle-orm';

import {
  issueWaitingInvoices,
  standingWithVerifiedPan,
  waitingOrders,
  type VendorRow,
} from './compliance-standing';

/*
 * The PAN verification transaction (SPEC core 10, "PAN verification", amended 2026-10-20 and
 * 2026-10-21). Moved here from the API's AdminComplianceService so the Super Admin's button and the
 * automated IRD check run one and the same transaction.
 */

/** The job name an automated verification is recorded under (vendors.pan_verified_by_job). */
export const IRD_PAN_VERIFICATION_JOB = 'IRD_PAN_VERIFICATION';

/** Who verifies: a Super Admin, or the automated IRD lookup. */
export type PanVerifier =
  | { readonly kind: 'USER'; readonly userId: string }
  | { readonly kind: 'JOB'; readonly job: typeof IRD_PAN_VERIFICATION_JOB };

/** The vendor does not exist. */
export class PanVendorNotFoundError extends Error {
  constructor(readonly vendorId: string) {
    super(`Vendor ${vendorId} not found`);
    this.name = 'PanVendorNotFoundError';
  }
}

/** The vendor has saved no PAN: there is nothing to verify. */
export class PanMissingError extends Error {
  constructor(readonly vendorId: string) {
    super(`Vendor ${vendorId} has no PAN on file`);
    this.name = 'PanMissingError';
  }
}

/**
 * Phase 35: the vendor has a PAN but uploaded no document for it. A verification needs both: the
 * Super Admin checks a document, never a bare number, and the automated check is held to the same.
 */
export class PanDocumentMissingError extends Error {
  constructor(readonly vendorId: string) {
    super(`Vendor ${vendorId} has uploaded no PAN document to verify`);
    this.name = 'PanDocumentMissingError';
  }
}

/** The automated check looked up a PAN the vendor has since replaced: it proves nothing now. */
export class PanChangedError extends Error {
  constructor(readonly vendorId: string) {
    super(`Vendor ${vendorId} has changed its PAN since the check was requested`);
    this.name = 'PanChangedError';
  }
}

export interface PanVerificationOptions {
  readonly context?: AuditContext;
  /** The automated check: refuse (PanChangedError) unless the vendor still has this PAN. */
  readonly expectTaxId?: string;
  /** Runs in the same transaction after the vendor row is updated (the check marks itself done). */
  readonly onVerified?: (tx: Transaction, vendor: VendorRow) => Promise<void>;
}

export interface PanVerificationResult {
  readonly vendor: VendorRow;
  /** The PAN was already verified (by anyone): nothing was written. */
  readonly alreadyVerified: boolean;
}

/**
 * One transaction under the vendor row lock (the lock a PAN change takes, so a verification never
 * lands on a PAN or a document that was replaced first), with its audit entries. A repeat keeps the
 * first stamp and records nothing.
 *
 * In the same transaction it lifts the compliance suspension (the shop returns to the status it
 * remembered), issues the invoices that waited for a verified seller, writes
 * `vendor.compliance_restored`, and closes the vendor's open IRD checks: a Super Admin's
 * verification resolves the one in manual review and supersedes one still queued.
 *
 * Lock order, the one a delivery uses: the waiting orders' rows, then the vendor row, then (inside
 * generateFiscalInvoice) the invoice sequence row, last. The order rows come first because the
 * invoice insert's foreign key reads the order row: taken after the sequence row, it could wait on
 * a transaction (the nightly reconciliation) that holds that order and waits for this shop's vendor
 * or sequence row. An order delivered after that first pass is picked up under the vendor lock
 * with SKIP LOCKED; one skipped there is held by a delivery or reconciliation, which reads the
 * vendor row after this commit and issues the invoice itself.
 */
export function verifyVendorPan(
  db: Database,
  vendorId: string,
  verifier: PanVerifier,
  options: PanVerificationOptions = {},
): Promise<PanVerificationResult> {
  const context = options.context ?? NO_AUDIT_CONTEXT;
  return db.transaction(async (tx) => {
    // Before the vendor lock (see the lock order above). An unverified shop is the only one that
    // can have invoices waiting; reading the stamp unlocked only decides this pass.
    const [shop] = await tx
      .select({ verifiedAt: vendors.pan_verified_at })
      .from(vendors)
      .where(eq(vendors.id, vendorId));
    if (shop?.verifiedAt === null) await waitingOrders(tx, vendorId, 'WAIT');

    const [before] = await tx.select().from(vendors).where(eq(vendors.id, vendorId)).for('update');
    if (before === undefined) throw new PanVendorNotFoundError(vendorId);
    if (before.tax_id === null) throw new PanMissingError(vendorId);
    if (options.expectTaxId !== undefined && before.tax_id !== options.expectTaxId) {
      throw new PanChangedError(vendorId);
    }
    if (before.pan_document_url === null) throw new PanDocumentMissingError(vendorId);
    const standing = standingWithVerifiedPan(before);
    if (before.pan_verified_at !== null && !standing.lifted) {
      return { vendor: before, alreadyVerified: true };
    }

    const actor: AuditActor =
      verifier.kind === 'USER'
        ? { kind: 'USER', user_id: verifier.userId, role: 'SUPER_ADMIN' }
        : { kind: 'SYSTEM', job: verifier.job };
    const firstStamp = before.pan_verified_at === null;
    const [after] = await tx
      .update(vendors)
      .set({
        pan_verified_at: before.pan_verified_at ?? sql`now()`,
        pan_verified_by_user_id: firstStamp
          ? verifier.kind === 'USER'
            ? verifier.userId
            : null
          : before.pan_verified_by_user_id,
        pan_verified_by_job: firstStamp
          ? verifier.kind === 'JOB'
            ? verifier.job
            : null
          : before.pan_verified_by_job,
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
        pan_verified_by_job: null,
      },
      afterState: {
        tax_id: after.tax_id,
        pan_verified_at: after.pan_verified_at?.toISOString() ?? null,
        pan_verified_by_user_id: after.pan_verified_by_user_id,
        pan_verified_by_job: after.pan_verified_by_job,
        status: after.status,
        ...(standing.lifted ? { compliance_suspension_lifted: true } : {}),
      },
      context,
    });

    if (verifier.kind === 'USER') await closeOpenIrdChecks(tx, vendorId, verifier.userId);
    await options.onVerified?.(tx, after);

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
    return { vendor: after, alreadyVerified: false };
  });
}

/**
 * A Super Admin verified the PAN by hand: the check waiting for them is RESOLVED (by them), and one
 * still queued or running is SUPERSEDED (the worker finds it closed and stops).
 */
async function closeOpenIrdChecks(tx: Transaction, vendorId: string, adminUserId: string) {
  await tx
    .update(irdPanChecks)
    .set({ status: 'RESOLVED', resolved_by_user_id: adminUserId, completed_at: sql`now()` })
    .where(and(eq(irdPanChecks.vendor_id, vendorId), eq(irdPanChecks.status, 'MANUAL_REVIEW')));
  await tx
    .update(irdPanChecks)
    .set({ status: 'SUPERSEDED', completed_at: sql`now()` })
    .where(
      and(
        eq(irdPanChecks.vendor_id, vendorId),
        inArray(irdPanChecks.status, ['QUEUED', 'RUNNING']),
      ),
    );
}
