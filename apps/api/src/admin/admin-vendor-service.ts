import {
  platformSettings,
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
import { asc, eq } from 'drizzle-orm';

import {
  AdminVendorNotFoundError,
  VendorStatusConflictError,
  type AdminOverride,
  type WalletService,
} from '../wallet/wallet-service';

export type AdminVendorRow = typeof vendors.$inferSelect;

export interface AdminVendorList {
  readonly vendors: readonly AdminVendorRow[];
  readonly suspensionLimitNpr: number;
}

export interface AdminOverrideResult {
  readonly override: AdminOverride;
  readonly vendor: AdminVendorRow;
}

/**
 * The Super Admin's vendor management (Phase 15): every vendor with its wallet and standing, and
 * the manual Suspend / Restore overrides. The overrides run inside WalletService (the one place that
 * changes a vendor's standing), in one transaction with their `vendor.status_overridden` outbox
 * event and their `audit_logs` entry (Phase 25; it was a console line before).
 */
export class AdminVendorService {
  constructor(
    private readonly db: Database,
    private readonly wallet: WalletService,
  ) {}

  /** One snapshot, so the balances and the limit agree. Sorted by business name, capped at 500. */
  list(): Promise<AdminVendorList> {
    return this.db.transaction(
      async (tx) => {
        const [settings] = await tx
          .select({ limit: platformSettings.vendor_wallet_suspension_limit_npr })
          .from(platformSettings);
        if (settings === undefined) throw new Error('platform_settings row is missing');
        const rows = await tx
          .select()
          .from(vendors)
          .orderBy(asc(vendors.business_name), asc(vendors.id))
          .limit(ADMIN_VENDOR_LIST_LIMIT);
        return { vendors: rows, suspensionLimitNpr: settings.limit };
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
  }

  suspend(
    adminUserId: string,
    vendorId: string,
    context: AuditContext = NO_AUDIT_CONTEXT,
  ): Promise<AdminOverrideResult> {
    return this.override(context, (tx) => this.wallet.suspendByAdmin(tx, vendorId, adminUserId));
  }

  restore(
    adminUserId: string,
    vendorId: string,
    context: AuditContext = NO_AUDIT_CONTEXT,
  ): Promise<AdminOverrideResult> {
    return this.override(context, (tx) => this.wallet.restoreByAdmin(tx, vendorId, adminUserId));
  }

  /**
   * Phase 37: reopens a shop its vendor closed (SPEC vendor flow 23: only a Super Admin can).
   * One transaction under the vendor row lock, with its audit entry. The shop returns LIVE, or
   * SUSPENDED_COMPLIANCE (remembering LIVE) when it has no PAN: no path sets LIVE without one,
   * and saving the PAN then brings it back by itself. The account can sign in again at once.
   * Ads and campaign opt-ins closed with the shop stay closed: the vendor buys and joins anew.
   */
  reactivate(
    adminUserId: string,
    vendorId: string,
    context: AuditContext = NO_AUDIT_CONTEXT,
  ): Promise<{ vendor: AdminVendorRow; previousStatus: 'DEACTIVATED' }> {
    return this.db.transaction(async (tx) => {
      const [before] = await tx
        .select()
        .from(vendors)
        .where(eq(vendors.id, vendorId))
        .for('update');
      if (before === undefined) throw new AdminVendorNotFoundError(vendorId);
      if (before.status !== 'DEACTIVATED') {
        throw new VendorStatusConflictError(vendorId, before.status, 'RESTORE');
      }
      const hasPan = before.tax_id !== null;
      const [vendor] = await tx
        .update(vendors)
        .set(
          hasPan
            ? { status: 'LIVE' }
            : { status: 'SUSPENDED_COMPLIANCE', status_before_compliance_suspension: 'LIVE' },
        )
        .where(eq(vendors.id, vendorId))
        .returning();
      if (vendor === undefined) throw new Error(`Vendor ${vendorId} vanished`);
      await recordAuditLog(tx, {
        actor: { kind: 'USER', user_id: adminUserId, role: 'SUPER_ADMIN' },
        action: 'VENDOR_REACTIVATED',
        entityId: vendorId,
        vendorId,
        beforeState: { status: before.status },
        afterState: { status: vendor.status, has_pan: hasPan },
        context,
      });
      return { vendor, previousStatus: 'DEACTIVATED' as const };
    });
  }

  private override(
    context: AuditContext,
    apply: (tx: Transaction) => Promise<AdminOverride>,
  ): Promise<AdminOverrideResult> {
    return this.db.transaction(async (tx) => {
      const override = await apply(tx);
      const [vendor] = await tx.select().from(vendors).where(eq(vendors.id, override.vendorId));
      if (vendor === undefined) throw new Error(`Vendor ${override.vendorId} vanished`);
      // In the override's own transaction: the standing never changes without its entry.
      await recordAuditLog(tx, {
        actor: { kind: 'USER', user_id: override.adminUserId, role: 'SUPER_ADMIN' },
        action:
          override.action === 'SUSPEND' ? 'VENDOR_SUSPENDED_BY_ADMIN' : 'VENDOR_RESTORED_BY_ADMIN',
        entityId: override.vendorId,
        vendorId: override.vendorId,
        beforeState: { status: override.fromStatus },
        afterState: {
          status: override.toStatus,
          wallet_balance_npr: override.walletBalanceNpr,
          overridden_at: override.overriddenAt.toISOString(),
        },
        context,
      });
      return { override, vendor };
    });
  }
}
