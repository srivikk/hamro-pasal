import { enqueueDomainEvent, platformSettings, vendors, type Database } from '@hamro-pasal/db';
import type { VendorStatus } from '@hamro-pasal/shared-types';
import { and, asc, eq, lt, ne } from 'drizzle-orm';

/** One vendor switched to SUSPENDED by the nightly reconciliation. */
export interface DebtSuspension {
  readonly vendorId: string;
  readonly previousStatus: Exclude<VendorStatus, 'SUSPENDED'>;
  readonly walletBalanceNpr: number;
  readonly suspensionLimitNpr: number;
  readonly suspendedAt: Date;
}

function isActive(status: VendorStatus): status is Exclude<VendorStatus, 'SUSPENDED'> {
  return status !== 'SUSPENDED';
}

/**
 * The `VENDOR_DEBT_RECONCILIATION` midnight task (SPEC §5, edge case 2). The
 * `enforce_vendor_wallet_limit` trigger suspends a vendor only when their row is written, so a
 * vendor already in debt when the Super Admin tightens the limit (−2000 → −1000, say) keeps
 * trading until their next posting. This sweep closes that gap.
 *
 * In one transaction:
 *   - read the current limit from platform_settings;
 *   - lock every vendor that is not SUSPENDED and whose wallet is strictly below it
 *     (`SELECT … FOR NO KEY UPDATE`; the same rule as the trigger, and the condition is re-checked
 *     on the locked row, so a top-up that commits first saves the vendor);
 *   - set them SUSPENDED (remembering the previous status in `status_before_debt_suspension`, which
 *     the API restores once the debt is cleared) and write one `vendor.suspended_for_debt` outbox
 *     event each.
 * Healthy vendors are not touched. A rerun (retried job) finds them already SUSPENDED and does
 * nothing, so each suspension is announced once.
 */
export class VendorDebtReconciliationService {
  constructor(
    private readonly db: Database,
    private readonly now: () => Date = () => new Date(),
  ) {}

  suspendIndebtedVendors(): Promise<DebtSuspension[]> {
    return this.db.transaction(async (tx) => {
      const [settings] = await tx
        .select({ limit: platformSettings.vendor_wallet_suspension_limit_npr })
        .from(platformSettings);
      if (settings === undefined) throw new Error('platform_settings row is missing');

      const breached = await tx
        .select({
          id: vendors.id,
          phone: vendors.phone,
          status: vendors.status,
          walletBalanceNpr: vendors.wallet_balance_npr,
        })
        .from(vendors)
        .where(and(ne(vendors.status, 'SUSPENDED'), lt(vendors.wallet_balance_npr, settings.limit)))
        // One lock order for every run, so concurrent sweeps cannot deadlock.
        .orderBy(asc(vendors.id))
        .for('no key update');
      if (breached.length === 0) return [];

      const suspendedAt = this.now();
      const suspensions: DebtSuspension[] = [];
      for (const vendor of breached) {
        const previousStatus = vendor.status;
        if (!isActive(previousStatus)) throw new Error(`Vendor ${vendor.id} was already suspended`);
        // Remembered so that clearing the debt restores it (API WalletService, Phase 12.5).
        await tx
          .update(vendors)
          .set({ status: 'SUSPENDED', status_before_debt_suspension: previousStatus })
          .where(eq(vendors.id, vendor.id));
        await enqueueDomainEvent(tx, {
          type: 'vendor.suspended_for_debt',
          aggregateId: vendor.id,
          occurredAt: suspendedAt,
          payload: {
            vendor_id: vendor.id,
            vendor_phone: vendor.phone,
            previous_status: previousStatus,
            wallet_balance_npr: vendor.walletBalanceNpr,
            suspension_limit_npr: settings.limit,
            suspended_at: suspendedAt.toISOString(),
          },
        });
        suspensions.push({
          vendorId: vendor.id,
          previousStatus,
          walletBalanceNpr: vendor.walletBalanceNpr,
          suspensionLimitNpr: settings.limit,
          suspendedAt,
        });
      }
      return suspensions;
    });
  }
}
