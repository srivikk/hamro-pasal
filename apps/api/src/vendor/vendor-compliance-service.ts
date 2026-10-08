import { recordAuditLog, vendors, type Database } from '@hamro-pasal/db';
import type {
  AuditActor,
  AuditContext,
  TaxIdentityRequest,
  VendorStatus,
} from '@hamro-pasal/shared-types';
import { eq } from 'drizzle-orm';

import { VendorAccountNotFoundError } from '../orders/vendor-order-service';

export type VendorRow = typeof vendors.$inferSelect;

export interface TaxIdentityResult {
  readonly vendor: VendorRow;
  /** This save lifted the shop's compliance suspension. */
  readonly complianceSuspensionLifted: boolean;
}

/**
 * The vendor's tax identity (SPEC core section 10, "PAN is mandatory" and "PAN verification").
 *
 * Saving a PAN is the only thing that lifts a compliance suspension, and it does so in the same
 * transaction: no admin route can. Saving a different PAN clears the Super Admin's verification,
 * which freezes the shop's payouts until the new PAN is verified; the shop keeps trading.
 */
export class VendorComplianceService {
  constructor(private readonly db: Database) {}

  /**
   * One transaction under the vendor row lock (the lock every wallet journal and admin override
   * takes), with its audit entries. A repeat with the same values changes and records nothing.
   */
  saveTaxIdentity(
    actor: AuditActor & { kind: 'USER' },
    input: TaxIdentityRequest,
    context: AuditContext,
  ): Promise<TaxIdentityResult> {
    return this.db.transaction(async (tx) => {
      const [before] = await tx
        .select()
        .from(vendors)
        .where(eq(vendors.user_id, actor.user_id))
        .for('update');
      if (before === undefined) throw new VendorAccountNotFoundError(actor.user_id);

      // A different PAN is a different document: the check of the old one says nothing about it.
      const verificationCleared = before.tax_id !== input.tax_id && before.pan_verified_at !== null;
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
        ...standing.columns,
      };

      const unchanged =
        before.tax_id === next.tax_id &&
        before.is_vat_registered === next.is_vat_registered &&
        before.legal_name === next.legal_name &&
        before.registered_address === next.registered_address &&
        !standing.lifted;
      if (unchanged) return { vendor: before, complianceSuspensionLifted: false };

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
      return { vendor: after, complianceSuspensionLifted: standing.lifted };
    });
  }
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
