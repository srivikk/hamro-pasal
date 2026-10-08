import { recordAuditLog, vendors, type Database } from '@hamro-pasal/db';
import { and, asc, eq, isNull } from 'drizzle-orm';

export const COMPLIANCE_SWEEP_JOB = 'VENDOR_COMPLIANCE_SWEEP';

export interface ComplianceSuspension {
  readonly vendorId: string;
  readonly businessName: string;
}

/**
 * SPEC core section 10, "PAN is mandatory": no vendor is LIVE without a PAN. The nightly sweep
 * moves every LIVE vendor whose `tax_id` is null to SUSPENDED_COMPLIANCE, remembering LIVE, so the
 * shop returns the moment its PAN is saved (PUT /api/vendor/tax-identity).
 *
 * The test is the PAN itself, not its verification: an unverified PAN freezes payouts, never
 * trading.
 */
export class ComplianceSweepService {
  constructor(private readonly db: Database) {}

  /**
   * One transaction per vendor, under the vendor row lock the PAN save also takes: a PAN saved
   * just before the sweep keeps the shop LIVE, and a rerun or a second worker finds nothing left.
   * Each suspension is audited in its own transaction, with the job as the actor.
   */
  async suspendVendorsWithoutPan(): Promise<ComplianceSuspension[]> {
    const candidates = await this.db
      .select({ id: vendors.id })
      .from(vendors)
      .where(and(eq(vendors.status, 'LIVE'), isNull(vendors.tax_id)))
      .orderBy(asc(vendors.id));

    const suspended: ComplianceSuspension[] = [];
    for (const { id } of candidates) {
      const result = await this.db.transaction(async (tx) => {
        const [vendor] = await tx.select().from(vendors).where(eq(vendors.id, id)).for('update');
        // Re-checked under the lock: the PAN may have arrived, or the status changed, meanwhile.
        if (vendor?.status !== 'LIVE' || vendor.tax_id !== null) return null;

        await tx
          .update(vendors)
          .set({ status: 'SUSPENDED_COMPLIANCE', status_before_compliance_suspension: 'LIVE' })
          .where(eq(vendors.id, id));
        await recordAuditLog(tx, {
          actor: { kind: 'SYSTEM', job: COMPLIANCE_SWEEP_JOB },
          action: 'VENDOR_SUSPENDED_FOR_COMPLIANCE',
          entityId: id,
          vendorId: id,
          beforeState: { status: 'LIVE', tax_id: null },
          afterState: { status: 'SUSPENDED_COMPLIANCE', tax_id: null, restores_to: 'LIVE' },
        });
        return { vendorId: id, businessName: vendor.business_name };
      });
      if (result !== null) suspended.push(result);
    }
    return suspended;
  }
}
