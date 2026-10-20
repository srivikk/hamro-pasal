import { recordAuditLog, vendors, type Database } from '@hamro-pasal/db';
import type {
  AuditActor,
  AuditContext,
  DisputeEvidenceContentType,
  TaxIdentityRequest,
} from '@hamro-pasal/shared-types';
import { isPanChecksumValid } from '@hamro-pasal/shared-types';
import { eq } from 'drizzle-orm';

import { VendorAccountNotFoundError } from '../orders/vendor-order-service';
import type { KycDocumentStorage } from '../uploads/kyc-document-storage';
import { requestIrdPanCheck, suspendForCompliance, type VendorRow } from '@hamro-pasal/ledger';

export type { VendorRow } from '@hamro-pasal/ledger';

export interface TaxIdentityResult {
  readonly vendor: VendorRow;
  /** This save changed a verified PAN and so took the LIVE shop offline (SUSPENDED_COMPLIANCE). */
  readonly complianceSuspended: boolean;
  /** The PAN number changed, so the document of the old number was removed. */
  readonly panDocumentRemoved: boolean;
}

export interface PanDocumentResult {
  readonly vendor: VendorRow;
  /** The upload took the place of an earlier document (which was then deleted). */
  readonly replaced: boolean;
  /** It replaced the document of a verified PAN: the shop waits for a new check. */
  readonly verificationCleared: boolean;
  /** ...and so the LIVE shop went offline (SUSPENDED_COMPLIANCE) until that check. */
  readonly complianceSuspended: boolean;
}

/**
 * The vendor's tax identity (SPEC core section 10, "PAN is mandatory" and "PAN verification",
 * amended 2026-10-20).
 *
 * A shop trades only on a PAN a Super Admin has verified, so nothing the vendor does here can bring
 * a shop online: saving a PAN never lifts a compliance suspension (the verification does, see
 * AdminComplianceService.verifyPan, which also issues the invoices that waited). Saving a different
 * PAN clears the verification and, for a LIVE shop, takes it offline in the same transaction. It
 * also removes the document uploaded for the old number (Phase 35): a document belongs to one PAN,
 * and an admin must never be shown the old certificate beside a new number.
 */
/**
 * PAN_CHECKSUM_ENFORCED (2026-10-21): the PAN fails the MOD 11-2 check digit. Refused before
 * anything is written, so a structurally invalid PAN never reaches the IRD check's queue.
 */
export class PanChecksumInvalidError extends Error {
  constructor(readonly taxId: string) {
    super(`PAN ${taxId} fails the check digit`);
    this.name = 'PanChecksumInvalidError';
  }
}

export interface VendorComplianceOptions {
  /** PAN_CHECKSUM_ENFORCED: refuse a PAN whose ninth digit is not its MOD 11-2 check digit. */
  readonly panChecksumEnforced?: boolean;
}

export class VendorComplianceService {
  constructor(
    private readonly db: Database,
    private readonly documents: KycDocumentStorage,
    private readonly options: VendorComplianceOptions = {},
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
   * the Super Admin checked the document that is being deleted, not this one. A LIVE shop goes
   * offline until the new check (SPEC core 10, amended 2026-10-20). A first document clears
   * nothing.
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

        const suspension = verificationCleared
          ? await suspendForCompliance(tx, before, actor, 'PAN_DOCUMENT_REPLACED', context)
          : null;

        const [after] = await tx
          .update(vendors)
          .set({
            pan_document_url: key,
            ...(verificationCleared
              ? { pan_verified_at: null, pan_verified_by_user_id: null }
              : {}),
            ...suspension,
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
        // A PAN and its document, not yet verified: the IRD lookup starts (2026-10-21).
        await requestIrdPanCheck(tx, after);
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
          result: {
            vendor: after,
            replaced,
            verificationCleared,
            complianceSuspended: suspension !== null,
          },
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
   * A changed PAN number sets `pan_document_url` to null in this transaction and, only after
   * the commit, deletes the object it named (the order `uploadPanDocument` keeps: a row never
   * names a missing object; a failed delete leaves a logged orphan). An upload racing this save
   * queues on the same vendor row lock, so whichever commits second decides what is on file. A
   * first PAN is not a change: a document uploaded before it is kept.
   *
   * A first PAN leaves a suspended shop suspended: it now needs its document and the Super Admin's
   * check. A changed PAN that was verified takes a LIVE shop offline here (SPEC core 10).
   */
  async saveTaxIdentity(
    actor: AuditActor & { kind: 'USER' },
    input: TaxIdentityRequest,
    context: AuditContext,
  ): Promise<TaxIdentityResult> {
    if (this.options.panChecksumEnforced === true && !isPanChecksumValid(input.tax_id)) {
      throw new PanChecksumInvalidError(input.tax_id);
    }
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
      };

      const unchanged =
        before.tax_id === next.tax_id &&
        before.is_vat_registered === next.is_vat_registered &&
        before.legal_name === next.legal_name &&
        before.registered_address === next.registered_address;
      if (unchanged) {
        return {
          result: { vendor: before, complianceSuspended: false, panDocumentRemoved: false },
          removedKey: null,
        };
      }

      // The new number has not been checked: a LIVE shop stops trading in this commit.
      const suspension = verificationCleared
        ? await suspendForCompliance(tx, before, actor, 'PAN_CHANGED', context)
        : null;

      const [after] = await tx
        .update(vendors)
        .set({ ...next, ...suspension })
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

      // A changed PAN supersedes the IRD check of the old one; a new name re-runs one that the
      // names did not match; a first PAN with its document on file starts one (2026-10-21).
      await requestIrdPanCheck(tx, after);

      return {
        result: {
          vendor: after,
          complianceSuspended: suspension !== null,
          panDocumentRemoved: removedKey !== null,
        },
        removedKey,
      };
    });
  }
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
