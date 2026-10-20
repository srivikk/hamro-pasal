import { enqueueDomainEvent, platformSettings, vendors, type Transaction } from '@hamro-pasal/db';
import {
  isPanVerified,
  panGatedStanding,
  type GatedStanding,
  type VendorStatus,
} from '@hamro-pasal/shared-types';
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

/** A restore lands on what the shop had before its suspension, never SUSPENDED again. */
function restoredStatusOf(standing: GatedStanding): ActiveStatus {
  if (!isActive(standing.status)) throw new Error('A restore cannot land on SUSPENDED');
  return standing.status;
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
          panVerifiedAt: vendors.pan_verified_at,
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
        // SPEC core 10 (amended 2026-10-20): clearing dues never makes a shop LIVE without a
        // verified PAN. It lands in SUSPENDED_COMPLIANCE instead, and the verification lifts it.
        const standing = panGatedStanding(
          vendor.restoreTo,
          isPanVerified({ pan_verified_at: vendor.panVerifiedAt }),
        );
        await tx
          .update(vendors)
          .set({ ...standing, status_before_debt_suspension: null })
          .where(eq(vendors.id, vendorId));
        await enqueueDomainEvent(tx, {
          type: 'vendor.restored',
          aggregateId: vendorId,
          occurredAt: at,
          payload: {
            vendor_id: vendorId,
            vendor_phone: vendor.phone,
            restored_status: restoredStatusOf(standing),
            wallet_balance_npr: vendor.walletBalanceNpr,
            transaction_id: transactionId,
            restored_at: at.toISOString(),
          },
        });
        changes.push({
          type: 'RESTORED',
          vendorId,
          restoredStatus: restoredStatusOf(standing),
          walletBalanceNpr: vendor.walletBalanceNpr,
        });
      }
    }
    return changes;
  }

  /**
   * Phase 15, Super Admin override: takes a vendor offline whatever its wallet says. The previous
   * status goes to `status_before_admin_suspension`, which only `restoreByAdmin` reads: paying dues
   * never lifts an admin suspension (applyThreshold restores debt suspensions only). A vendor that
   * is already SUSPENDED (for debt or by an admin) is refused.
   */
  async suspendByAdmin(
    tx: Transaction,
    vendorId: string,
    adminUserId: string,
  ): Promise<AdminOverride> {
    const vendor = await lockVendor(tx, vendorId);
    // A closed shop has no standing to suspend, and a Restore must never bring it back.
    if (!isActive(vendor.status) || vendor.status === 'DEACTIVATED') {
      throw new VendorStatusConflictError(vendorId, vendor.status, 'SUSPEND');
    }
    await tx
      .update(vendors)
      .set({ status: 'SUSPENDED', status_before_admin_suspension: vendor.status })
      .where(eq(vendors.id, vendorId));
    return this.recordOverride(tx, {
      vendorId,
      action: 'SUSPEND',
      fromStatus: vendor.status,
      toStatus: 'SUSPENDED',
      walletBalanceNpr: vendor.walletBalanceNpr,
      adminUserId,
      overriddenAt: this.now(),
    });
  }

  /**
   * Phase 15, Super Admin override: brings a SUSPENDED vendor back to the status it had before,
   * whether an admin or wallet debt suspended it. For a debt suspension this lifts it before the
   * balance is back to 0 (the admin's call), but never while the balance is still below the limit:
   * SPEC §5 keeps such a vendor locked, and the wallet trigger would refuse the update anyway.
   */
  async restoreByAdmin(
    tx: Transaction,
    vendorId: string,
    adminUserId: string,
  ): Promise<AdminOverride> {
    const vendor = await lockVendor(tx, vendorId);
    if (vendor.status !== 'SUSPENDED') {
      throw new VendorStatusConflictError(vendorId, vendor.status, 'RESTORE');
    }
    const restoreTo = vendor.adminRestoreTo ?? vendor.debtRestoreTo;
    if (restoreTo === null) throw new RestoreStatusUnknownError(vendorId);
    const limit = await suspensionLimit(tx);
    if (vendor.walletBalanceNpr < limit) {
      throw new WalletBelowSuspensionLimitError(vendorId, vendor.walletBalanceNpr, limit);
    }
    // Never LIVE without a verified PAN (SPEC core 10, amended 2026-10-20).
    const standing = panGatedStanding(
      restoreTo,
      isPanVerified({ pan_verified_at: vendor.panVerifiedAt }),
    );
    await tx
      .update(vendors)
      .set({
        ...standing,
        status_before_admin_suspension: null,
        status_before_debt_suspension: null,
      })
      .where(eq(vendors.id, vendorId));
    return this.recordOverride(tx, {
      vendorId,
      action: 'RESTORE',
      fromStatus: 'SUSPENDED',
      toStatus: standing.status,
      walletBalanceNpr: vendor.walletBalanceNpr,
      adminUserId,
      overriddenAt: this.now(),
    });
  }

  /** The audit record of an override (SPEC infrastructure §5), in the override's transaction. */
  private async recordOverride(tx: Transaction, override: AdminOverride): Promise<AdminOverride> {
    await enqueueDomainEvent(tx, {
      type: 'vendor.status_overridden',
      aggregateId: override.vendorId,
      occurredAt: override.overriddenAt,
      payload: {
        vendor_id: override.vendorId,
        action: override.action,
        from_status: override.fromStatus,
        to_status: override.toStatus,
        wallet_balance_npr: override.walletBalanceNpr,
        admin_user_id: override.adminUserId,
        overridden_at: override.overriddenAt.toISOString(),
      },
    });
    return override;
  }
}

/** Locks one vendor row like lockStandings does, for an admin override. */
async function lockVendor(tx: Transaction, vendorId: string) {
  const [vendor] = await tx
    .select({
      status: vendors.status,
      walletBalanceNpr: vendors.wallet_balance_npr,
      debtRestoreTo: vendors.status_before_debt_suspension,
      adminRestoreTo: vendors.status_before_admin_suspension,
      panVerifiedAt: vendors.pan_verified_at,
    })
    .from(vendors)
    .where(eq(vendors.id, vendorId))
    .for('no key update');
  if (vendor === undefined) throw new AdminVendorNotFoundError(vendorId);
  return vendor;
}

async function suspensionLimit(tx: Transaction): Promise<number> {
  const [settings] = await tx
    .select({ limit: platformSettings.vendor_wallet_suspension_limit_npr })
    .from(platformSettings);
  if (settings === undefined) throw new Error('platform_settings row is missing');
  return settings.limit;
}

/** Phase 15: a Super Admin override asked for a status the vendor cannot move to from here. */
export class VendorStatusConflictError extends Error {
  constructor(
    readonly vendorId: string,
    readonly status: VendorStatus,
    readonly action: AdminOverrideAction,
  ) {
    super(
      action === 'SUSPEND'
        ? `Vendor ${vendorId} is already SUSPENDED`
        : `Vendor ${vendorId} is ${status}, not SUSPENDED`,
    );
    this.name = 'VendorStatusConflictError';
  }
}

/**
 * Restoring would leave an active vendor below the suspension limit (SPEC §5): the dues must be
 * paid first. The enforce_vendor_wallet_limit trigger refuses the same change in the database.
 */
export class WalletBelowSuspensionLimitError extends Error {
  constructor(
    readonly vendorId: string,
    readonly walletBalanceNpr: number,
    readonly suspensionLimitNpr: number,
  ) {
    super(
      `Vendor ${vendorId} is at ${String(walletBalanceNpr)} NPR, below the ${String(suspensionLimitNpr)} NPR limit`,
    );
    this.name = 'WalletBelowSuspensionLimitError';
  }
}

/** SUSPENDED with no remembered status (set outside the app): nothing says what to restore to. */
export class RestoreStatusUnknownError extends Error {
  constructor(readonly vendorId: string) {
    super(`Vendor ${vendorId} has no status to restore to`);
    this.name = 'RestoreStatusUnknownError';
  }
}

/** The vendor row is gone (or never existed). */
export class AdminVendorNotFoundError extends Error {
  constructor(readonly vendorId: string) {
    super(`Vendor ${vendorId} not found`);
    this.name = 'AdminVendorNotFoundError';
  }
}

export type AdminOverrideAction = 'SUSPEND' | 'RESTORE';

export interface AdminOverride {
  readonly vendorId: string;
  readonly action: AdminOverrideAction;
  readonly fromStatus: VendorStatus;
  readonly toStatus: VendorStatus;
  readonly walletBalanceNpr: number;
  readonly adminUserId: string;
  readonly overriddenAt: Date;
}
