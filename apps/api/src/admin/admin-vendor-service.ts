import { platformSettings, vendors, type Database, type Transaction } from '@hamro-pasal/db';
import { ADMIN_VENDOR_LIST_LIMIT } from '@hamro-pasal/shared-types';
import { asc, eq } from 'drizzle-orm';

import type { AdminOverride, WalletService } from '../wallet/wallet-service';

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
 * event; a structured audit line is logged after the commit (SPEC infrastructure §5).
 */
export class AdminVendorService {
  constructor(
    private readonly db: Database,
    private readonly wallet: WalletService,
    private readonly audit: (line: string) => void = (line) => {
      console.warn(line);
    },
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

  suspend(adminUserId: string, vendorId: string): Promise<AdminOverrideResult> {
    return this.override((tx) => this.wallet.suspendByAdmin(tx, vendorId, adminUserId));
  }

  restore(adminUserId: string, vendorId: string): Promise<AdminOverrideResult> {
    return this.override((tx) => this.wallet.restoreByAdmin(tx, vendorId, adminUserId));
  }

  private async override(
    apply: (tx: Transaction) => Promise<AdminOverride>,
  ): Promise<AdminOverrideResult> {
    const result = await this.db.transaction(async (tx) => {
      const override = await apply(tx);
      const [vendor] = await tx.select().from(vendors).where(eq(vendors.id, override.vendorId));
      if (vendor === undefined) throw new Error(`Vendor ${override.vendorId} vanished`);
      return { override, vendor };
    });
    const { override } = result;
    this.audit(
      JSON.stringify({
        audit: 'vendor.status_overridden',
        vendor_id: override.vendorId,
        action: override.action,
        from_status: override.fromStatus,
        to_status: override.toStatus,
        wallet_balance_npr: override.walletBalanceNpr,
        admin_user_id: override.adminUserId,
        overridden_at: override.overriddenAt.toISOString(),
      }),
    );
    return result;
  }
}
