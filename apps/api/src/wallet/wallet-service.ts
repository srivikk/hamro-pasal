import { enqueueDomainEvent, platformSettings, vendors, type Transaction } from '@hamro-pasal/db';
import type { VendorStatus } from '@hamro-pasal/shared-types';
import { asc, eq, inArray } from 'drizzle-orm';

type ActiveStatus = Exclude<VendorStatus, 'SUSPENDED'>;

/** A vendor's status before a journal moved its wallet (see WalletService.lockStandings). */
export type StandingsBefore = ReadonlyMap<string, VendorStatus>;

/** What a journal did to a vendor's standing. */
export type StandingChange =
  | {
      readonly type: 'SUSPENDED_FOR_DEBT';
      readonly vendorId: string;
      readonly previousStatus: ActiveStatus;
      readonly walletBalanceNpr: number;
      readonly suspensionLimitNpr: number;
    }
  | {
      readonly type: 'RESTORED';
      readonly vendorId: string;
      readonly restoredStatus: ActiveStatus;
      readonly walletBalanceNpr: number;
    };

function isActive(status: VendorStatus): status is ActiveStatus {
  return status !== 'SUSPENDED';
}

/**
 * SPEC §5 at the application layer (Phase 12.5): every journal that moves a vendor wallet is
 * evaluated against the Super Admin's suspension limit, in the journal's own transaction.
 *
 *  - Balance strictly below the limit, vendor not SUSPENDED before the journal: SUSPENDED, the
 *    previous status kept in `status_before_debt_suspension`, `vendor.suspended_for_debt` in the
 *    outbox (then Kafka).
 *  - Vendor SUSPENDED for debt (the column is set) and the balance back at 0 or above (SPEC: "until
 *    they clear the negative balance"): the previous status is restored and `vendor.restored` is
 *    written. Any other suspension (an admin's) is never lifted here.
 *
 * The `enforce_vendor_wallet_limit` trigger stays as the database's safety net (user decision): it
 * flips the row to SUSPENDED in the posting's own write, before this service runs, which is why the
 * transition is judged against the status captured by `lockStandings`, not the row's current one.
 */
export class WalletService {
  constructor(private readonly now: () => Date = () => new Date()) {}

  /**
   * Call before posting: locks the vendor rows (`FOR NO KEY UPDATE`: new orders' foreign-key checks
   * on the vendor are not blocked), in id order, so concurrent journals
   * serialise per vendor and cannot deadlock, and records their status.
   */
  async lockStandings(tx: Transaction, vendorIds: readonly string[]): Promise<StandingsBefore> {
    if (vendorIds.length === 0) return new Map();
    const rows = await tx
      .select({ id: vendors.id, status: vendors.status })
      .from(vendors)
      .where(inArray(vendors.id, [...new Set(vendorIds)]))
      .orderBy(asc(vendors.id))
      .for('no key update');
    return new Map(rows.map((row) => [row.id, row.status]));
  }

  /** Call after posting, in the same transaction: applies the threshold and writes the events. */
  async applyThreshold(
    tx: Transaction,
    before: StandingsBefore,
    transactionId: string,
  ): Promise<StandingChange[]> {
    if (before.size === 0) return [];
    const [settings] = await tx
      .select({ limit: platformSettings.vendor_wallet_suspension_limit_npr })
      .from(platformSettings);
    if (settings === undefined) throw new Error('platform_settings row is missing');

    const changes: StandingChange[] = [];
    for (const [vendorId, statusBefore] of [...before].sort(([a], [b]) => (a < b ? -1 : 1))) {
      const [vendor] = await tx
        .select({
          phone: vendors.phone,
          status: vendors.status,
          walletBalanceNpr: vendors.wallet_balance_npr,
          restoreTo: vendors.status_before_debt_suspension,
        })
        .from(vendors)
        .where(eq(vendors.id, vendorId));
      if (vendor === undefined) throw new Error(`Vendor ${vendorId} vanished while posting`);
      const at = this.now();

      if (vendor.walletBalanceNpr < settings.limit) {
        if (!isActive(statusBefore)) continue; // already suspended (for debt or otherwise)
        await tx
          .update(vendors)
          .set({ status: 'SUSPENDED', status_before_debt_suspension: statusBefore })
          .where(eq(vendors.id, vendorId));
        await enqueueDomainEvent(tx, {
          type: 'vendor.suspended_for_debt',
          aggregateId: vendorId,
          occurredAt: at,
          payload: {
            vendor_id: vendorId,
            vendor_phone: vendor.phone,
            previous_status: statusBefore,
            wallet_balance_npr: vendor.walletBalanceNpr,
            suspension_limit_npr: settings.limit,
            suspended_at: at.toISOString(),
          },
        });
        changes.push({
          type: 'SUSPENDED_FOR_DEBT',
          vendorId,
          previousStatus: statusBefore,
          walletBalanceNpr: vendor.walletBalanceNpr,
          suspensionLimitNpr: settings.limit,
        });
        continue;
      }

      if (
        vendor.status === 'SUSPENDED' &&
        vendor.restoreTo !== null &&
        vendor.walletBalanceNpr >= 0
      ) {
        await tx
          .update(vendors)
          .set({ status: vendor.restoreTo, status_before_debt_suspension: null })
          .where(eq(vendors.id, vendorId));
        await enqueueDomainEvent(tx, {
          type: 'vendor.restored',
          aggregateId: vendorId,
          occurredAt: at,
          payload: {
            vendor_id: vendorId,
            vendor_phone: vendor.phone,
            restored_status: vendor.restoreTo,
            wallet_balance_npr: vendor.walletBalanceNpr,
            transaction_id: transactionId,
            restored_at: at.toISOString(),
          },
        });
        changes.push({
          type: 'RESTORED',
          vendorId,
          restoredStatus: vendor.restoreTo,
          walletBalanceNpr: vendor.walletBalanceNpr,
        });
      }
    }
    return changes;
  }
}
