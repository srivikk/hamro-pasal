import { enqueueDomainEvent, recordAuditLog, vendors, type Database } from '@hamro-pasal/db';
import { and, asc, eq, isNull } from 'drizzle-orm';

export const COMPLIANCE_SWEEP_JOB = 'VENDOR_COMPLIANCE_SWEEP';

export interface ComplianceSuspension {
  readonly vendorId: string;
  readonly businessName: string;
}

/**
 * SPEC core section 10, "PAN is mandatory" and "PAN verification" (amended 2026-10-20): no vendor
 * is LIVE without a PAN a Super Admin has verified. The sweep moves every LIVE vendor whose
 * `pan_verified_at` is null (which covers having no PAN at all) to SUSPENDED_COMPLIANCE,
 * remembering LIVE, so the shop returns the moment its PAN is verified
 * (POST /api/admin/vendors/:id/pan-verification).
 *
 * Every path to LIVE already checks the verification; this is the backstop. It runs at midnight
 * and once at every worker start, which is what takes the shops from before the rule offline.
 */
export class ComplianceSweepService {
  constructor(private readonly db: Database) {}

  /**
   * One transaction per vendor, under the vendor row lock the verification also takes: a PAN
   * verified just before the sweep keeps the shop LIVE, and a rerun or a second worker finds
   * nothing left.
   * Each suspension is audited in its own transaction, with the job as the actor, and writes
   * `vendor.suspended_for_compliance` to the outbox there (Phase 35): the event exists exactly
   * when the suspension committed.
   */
  async suspendUnverifiedVendors(): Promise<ComplianceSuspension[]> {
    const candidates = await this.db
      .select({ id: vendors.id })
      .from(vendors)
      .where(and(eq(vendors.status, 'LIVE'), isNull(vendors.pan_verified_at)))
      .orderBy(asc(vendors.id));

    const suspended: ComplianceSuspension[] = [];
    for (const { id } of candidates) {
      const result = await this.db.transaction(async (tx) => {
        const [vendor] = await tx.select().from(vendors).where(eq(vendors.id, id)).for('update');
        // Re-checked under the lock: the PAN may have been verified, or the status changed.
        if (vendor?.status !== 'LIVE' || vendor.pan_verified_at !== null) return null;

        await tx
          .update(vendors)
          .set({ status: 'SUSPENDED_COMPLIANCE', status_before_compliance_suspension: 'LIVE' })
          .where(eq(vendors.id, id));
        await recordAuditLog(tx, {
          actor: { kind: 'SYSTEM', job: COMPLIANCE_SWEEP_JOB },
          action: 'VENDOR_SUSPENDED_FOR_COMPLIANCE',
          entityId: id,
          vendorId: id,
          beforeState: { status: 'LIVE', tax_id: vendor.tax_id, pan_verified_at: null },
          afterState: {
            status: 'SUSPENDED_COMPLIANCE',
            tax_id: vendor.tax_id,
            restores_to: 'LIVE',
            reason: vendor.tax_id === null ? 'NO_PAN' : 'PAN_NOT_VERIFIED',
          },
        });
        const suspendedAt = new Date();
        await enqueueDomainEvent(tx, {
          type: 'vendor.suspended_for_compliance',
          aggregateId: id,
          occurredAt: suspendedAt,
          payload: {
            vendor_id: id,
            vendor_phone: vendor.phone,
            previous_status: 'LIVE',
            suspended_at: suspendedAt.toISOString(),
          },
        });
        return { vendorId: id, businessName: vendor.business_name };
      });
      if (result !== null) suspended.push(result);
    }
    return suspended;
  }
}
