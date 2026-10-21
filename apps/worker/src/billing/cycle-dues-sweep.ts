import { enqueueDomainEvent, recordAuditLog, vendors, type Database } from '@hamro-pasal/db';
import type { VendorStatus } from '@hamro-pasal/shared-types';
import { asc, eq, lte } from 'drizzle-orm';

export const CYCLE_DUES_SWEEP_JOB = 'CYCLE_DUES_SWEEP';

export interface CycleDuesSweepSummary {
  /** Shops suspended for debt: their dues were not cleared in time. */
  readonly suspended: readonly string[];
  /** Notices closed without a suspension (cleared, or the shop was already offline). */
  readonly closed: number;
}

/**
 * 2026-10-21 (SPEC core 4, "Cycle dues"): every notice past its due time is settled. With the
 * wallet still below 0 the shop is suspended for debt, exactly as the suspension limit would
 * (status SUSPENDED, the previous status kept in `status_before_debt_suspension`, so paying the
 * balance back to 0 restores it through WalletService), with `vendor.suspended_for_dues`. A shop
 * whose wallet is at 0 or above, or that is already SUSPENDED or DEACTIVATED, only has its notice
 * closed.
 *
 * One transaction per shop under its row lock (the lock every wallet journal takes), so a payment
 * that lands at the same moment is either seen (no suspension) or waits and then restores it.
 * Safe to run twice: the notice is gone after the first run.
 */
export class CycleDuesSweepService {
  constructor(
    private readonly db: Database,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async run(): Promise<CycleDuesSweepSummary> {
    const at = this.now();
    const due = await this.db
      .select({ id: vendors.id })
      .from(vendors)
      .where(lte(vendors.dues_due_at, at))
      .orderBy(asc(vendors.id));
    const suspended: string[] = [];
    let closed = 0;
    for (const { id } of due) {
      const outcome = await this.settle(id, at);
      if (outcome === 'SUSPENDED') suspended.push(id);
      if (outcome === 'CLOSED') closed += 1;
    }
    return { suspended, closed };
  }

  private settle(vendorId: string, at: Date): Promise<'SUSPENDED' | 'CLOSED' | 'NONE'> {
    return this.db.transaction(async (tx) => {
      const [vendor] = await tx
        .select()
        .from(vendors)
        .where(eq(vendors.id, vendorId))
        .for('no key update');
      // Re-checked under the lock: a payment or another run may have closed it.
      if (vendor?.dues_due_at == null || vendor.dues_due_at > at) return 'NONE';
      const dues = vendor.dues_amount_npr ?? 0;
      const clear = { dues_notice_opened_at: null, dues_due_at: null, dues_amount_npr: null };

      const previous: VendorStatus = vendor.status;
      if (
        vendor.wallet_balance_npr >= 0 ||
        previous === 'SUSPENDED' ||
        previous === 'DEACTIVATED'
      ) {
        await tx.update(vendors).set(clear).where(eq(vendors.id, vendorId));
        return 'CLOSED';
      }

      await tx
        .update(vendors)
        .set({ ...clear, status: 'SUSPENDED', status_before_debt_suspension: previous })
        .where(eq(vendors.id, vendorId));
      await recordAuditLog(tx, {
        actor: { kind: 'SYSTEM', job: CYCLE_DUES_SWEEP_JOB },
        action: 'VENDOR_SUSPENDED_FOR_DUES',
        entityId: vendorId,
        vendorId,
        beforeState: { status: previous, dues_amount_npr: dues },
        afterState: { status: 'SUSPENDED', wallet_balance_npr: vendor.wallet_balance_npr },
      });
      await enqueueDomainEvent(tx, {
        type: 'vendor.suspended_for_dues',
        aggregateId: vendorId,
        occurredAt: at,
        payload: {
          vendor_id: vendorId,
          vendor_phone: vendor.phone,
          previous_status: previous,
          wallet_balance_npr: vendor.wallet_balance_npr,
          dues_amount_npr: dues,
          suspended_at: at.toISOString(),
        },
      });
      return 'SUSPENDED';
    });
  }
}
