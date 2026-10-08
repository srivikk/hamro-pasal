import {
  ledgerAccounts,
  ledgerEntries,
  ledgerTransactions,
  orders,
  platformSettings,
  vendors,
  type Database,
  type Transaction,
} from '@hamro-pasal/db';
import {
  VENDOR_WALLET_LEDGER_DEFAULT_LIMIT,
  type FulfillmentMode,
  type LedgerTransactionKind,
  type PaymentMethod,
  type VendorStatus,
  type WalletEntryType,
} from '@hamro-pasal/shared-types';
import { and, desc, eq, inArray, ne, sql } from 'drizzle-orm';

import { toNpr, toPaisa } from '../ledger/money';
import { VendorAccountNotFoundError } from '../orders/vendor-order-service';

/** The `cursor` is not an entry of this vendor's wallet (stale, forged or another vendor's). */
export class InvalidLedgerCursorError extends Error {
  constructor(readonly cursor: string) {
    super(`Cursor ${cursor} is not an entry of this wallet`);
    this.name = 'InvalidLedgerCursorError';
  }
}

export interface VendorWalletBalance {
  readonly vendorId: string;
  readonly status: VendorStatus;
  readonly suspendedForDebt: boolean;
  readonly walletBalanceNpr: number;
  readonly suspensionLimitNpr: number;
  readonly pendingEscrowNpr: number;
  readonly pendingEscrowOrderCount: number;
}

export interface WalletEntryOrder {
  readonly id: string;
  readonly paymentMethod: PaymentMethod;
  readonly fulfillment: FulfillmentMode;
  readonly subtotalNpr: number;
  readonly deliveryFeeNpr: number;
  readonly commissionNpr: number;
}

export interface VendorWalletEntry {
  readonly id: string;
  readonly transactionId: string;
  readonly kind: LedgerTransactionKind;
  readonly entryType: WalletEntryType;
  readonly amountNpr: number;
  readonly balanceAfterNpr: number;
  readonly description: string | null;
  readonly createdAt: Date;
  readonly order: WalletEntryOrder | null;
}

export interface VendorWalletPage {
  readonly entries: readonly VendorWalletEntry[];
  readonly nextCursor: string | null;
}

/**
 * Orders whose prepaid money sits in SYSTEM_ESCROW on the vendor's behalf: captured (PAID), not yet
 * settled (settlement happens in the DELIVERED commit). Refunds only exist on CANCELED / FAILED
 * orders, which these states exclude. DISPUTED escrow stays
 * frozen until arbitration, so it is still pending.
 */
const ESCROW_HELD_STATES = ['PLACED', 'PREPARING', 'OUT_FOR_DELIVERY', 'DISPUTED'] as const;

/**
 * The vendor's view of its money (SPEC §5): the VENDOR_WALLET balance (its projection
 * `vendors.wallet_balance_npr`), the prepaid earnings still in escrow, and the wallet's postings.
 * Read-only; every read runs in one REPEATABLE READ snapshot so the figures agree with each other.
 */
export class VendorWalletService {
  constructor(private readonly db: Database) {}

  balance(vendorUserId: string): Promise<VendorWalletBalance> {
    return this.snapshot(async (tx) => {
      const vendor = await vendorOf(tx, vendorUserId);
      const [settings] = await tx
        .select({ limit: platformSettings.vendor_wallet_suspension_limit_npr })
        .from(platformSettings);
      if (settings === undefined) throw new Error('platform_settings row is missing');

      const escrow = await pendingEscrowOf(tx, vendor.id);

      return {
        vendorId: vendor.id,
        status: vendor.status,
        suspendedForDebt: vendor.status === 'SUSPENDED' && vendor.restoreTo !== null,
        walletBalanceNpr: vendor.walletBalanceNpr,
        suspensionLimitNpr: settings.limit,
        pendingEscrowNpr: escrow.totalNpr,
        pendingEscrowOrderCount: escrow.orderCount,
      };
    });
  }

  /**
   * One page of the wallet's postings, newest first (by posting time, then id). Keyset pagination
   * on the entry id: `cursor` is the last entry of the previous page. Each entry carries the
   * balance right after it, derived from the sum of every posting up to the page's newest one.
   */
  ledger(
    vendorUserId: string,
    {
      limit = VENDOR_WALLET_LEDGER_DEFAULT_LIMIT,
      cursor,
    }: { limit?: number | undefined; cursor?: string | undefined },
  ): Promise<VendorWalletPage> {
    return this.snapshot(async (tx) => {
      const vendor = await vendorOf(tx, vendorUserId);
      const [account] = await tx
        .select({ id: ledgerAccounts.id })
        .from(ledgerAccounts)
        .where(eq(ledgerAccounts.vendor_id, vendor.id));
      // Every vendor gets its wallet account from a trigger at insert time.
      if (account === undefined) throw new Error(`Vendor ${vendor.id} has no wallet account`);

      if (cursor !== undefined) {
        const [known] = await tx
          .select({ id: ledgerEntries.id })
          .from(ledgerEntries)
          .where(and(eq(ledgerEntries.id, cursor), eq(ledgerEntries.account_id, account.id)));
        if (known === undefined) throw new InvalidLedgerCursorError(cursor);
      }

      const rows = await tx
        .select({
          id: ledgerEntries.id,
          transactionId: ledgerEntries.transaction_id,
          amountNpr: ledgerEntries.amount_npr,
          createdAt: ledgerEntries.created_at,
          kind: ledgerTransactions.kind,
          description: ledgerTransactions.description,
          orderId: orders.id,
          paymentMethod: orders.payment_method,
          fulfillment: orders.fulfillment_locked,
          subtotal: orders.subtotal,
          deliveryFee: orders.delivery_fee,
          commission: orders.platform_commission_amount,
        })
        .from(ledgerEntries)
        .innerJoin(ledgerTransactions, eq(ledgerTransactions.id, ledgerEntries.transaction_id))
        .leftJoin(orders, eq(orders.id, ledgerTransactions.order_id))
        .where(
          and(
            eq(ledgerEntries.account_id, account.id),
            // Compared in SQL against the cursor row itself: timestamps keep their microseconds.
            cursor === undefined
              ? undefined
              : sql`(${ledgerEntries.created_at}, ${ledgerEntries.id}) <
                  (SELECT c.created_at, c.id FROM ledger_entries c WHERE c.id = ${cursor})`,
          ),
        )
        .orderBy(desc(ledgerEntries.created_at), desc(ledgerEntries.id))
        .limit(limit + 1);

      const page = rows.slice(0, limit);
      const newest = page[0];
      if (newest === undefined) return { entries: [], nextCursor: null };

      const [upToNewest] = await tx
        .select({
          total: sql<number>`coalesce(sum(${ledgerEntries.amount_npr}), 0)`.mapWith(Number),
        })
        .from(ledgerEntries)
        .where(
          and(
            eq(ledgerEntries.account_id, account.id),
            sql`(${ledgerEntries.created_at}, ${ledgerEntries.id}) <=
              (SELECT c.created_at, c.id FROM ledger_entries c WHERE c.id = ${newest.id})`,
          ),
        );

      let balancePaisa = toPaisa(upToNewest?.total ?? 0);
      const entries = page.map((row): VendorWalletEntry => {
        const entry: VendorWalletEntry = {
          id: row.id,
          transactionId: row.transactionId,
          kind: row.kind,
          entryType: entryTypeOf(row.kind, row.amountNpr),
          amountNpr: row.amountNpr,
          balanceAfterNpr: toNpr(balancePaisa),
          description: row.description,
          createdAt: row.createdAt,
          order:
            row.orderId === null ||
            row.paymentMethod === null ||
            row.fulfillment === null ||
            row.subtotal === null ||
            row.deliveryFee === null ||
            row.commission === null
              ? null
              : {
                  id: row.orderId,
                  paymentMethod: row.paymentMethod,
                  fulfillment: row.fulfillment,
                  subtotalNpr: row.subtotal,
                  deliveryFeeNpr: row.deliveryFee,
                  commissionNpr: row.commission,
                },
        };
        balancePaisa -= toPaisa(row.amountNpr);
        return entry;
      });

      const last = page.at(-1);
      return { entries, nextCursor: rows.length > limit && last !== undefined ? last.id : null };
    });
  }

  private snapshot<T>(read: (tx: Transaction) => Promise<T>): Promise<T> {
    return this.db.transaction(read, {
      isolationLevel: 'repeatable read',
      accessMode: 'read only',
    });
  }
}

async function vendorOf(tx: Transaction, vendorUserId: string) {
  const [vendor] = await tx
    .select({
      id: vendors.id,
      status: vendors.status,
      walletBalanceNpr: vendors.wallet_balance_npr,
      restoreTo: vendors.status_before_debt_suspension,
    })
    .from(vendors)
    .where(eq(vendors.user_id, vendorUserId));
  if (vendor === undefined) throw new VendorAccountNotFoundError(vendorUserId);
  return vendor;
}

/** The vendor's share of the prepaid money still held in SYSTEM_ESCROW (see ESCROW_HELD_STATES). */
export async function pendingEscrowOf(
  tx: Transaction,
  vendorId: string,
): Promise<{ readonly totalNpr: number; readonly orderCount: number }> {
  const [escrow] = await tx
    .select({
      // What settlement will credit: subtotal − the vendor's share of a campaign discount −
      // commission, plus the fee when the shop delivers.
      total: sql<number>`coalesce(sum(${orders.subtotal} - ${orders.platform_promo_vendor_share_npr}
          - ${orders.platform_commission_amount}
          + CASE WHEN ${orders.fulfillment_locked} = 'SELF_DELIVERY'
                 THEN ${orders.delivery_fee} ELSE 0 END), 0)`.mapWith(Number),
      count: sql<number>`count(*)`.mapWith(Number),
    })
    .from(orders)
    .where(
      and(
        eq(orders.vendor_id, vendorId),
        ne(orders.payment_method, 'COD'),
        eq(orders.payment_status, 'PAID'),
        inArray(orders.state, [...ESCROW_HELD_STATES]),
      ),
    );
  return { totalNpr: escrow?.total ?? 0, orderCount: escrow?.count ?? 0 };
}

/** `pendingEscrowOf` for several vendors in one query; a vendor with none is absent. */
export async function pendingEscrowByVendor(
  tx: Transaction,
  vendorIds: readonly string[],
): Promise<Map<string, number>> {
  if (vendorIds.length === 0) return new Map();
  const rows = await tx
    .select({
      vendorId: orders.vendor_id,
      total: sql<number>`coalesce(sum(${orders.subtotal} - ${orders.platform_promo_vendor_share_npr}
          - ${orders.platform_commission_amount}
          + CASE WHEN ${orders.fulfillment_locked} = 'SELF_DELIVERY'
                 THEN ${orders.delivery_fee} ELSE 0 END), 0)`.mapWith(Number),
    })
    .from(orders)
    .where(
      and(
        inArray(orders.vendor_id, [...vendorIds]),
        ne(orders.payment_method, 'COD'),
        eq(orders.payment_status, 'PAID'),
        inArray(orders.state, [...ESCROW_HELD_STATES]),
      ),
    )
    .groupBy(orders.vendor_id);
  return new Map(rows.map((row) => [row.vendorId, row.total]));
}

/** What a posting means to the vendor (see walletEntryTypes in shared-types). */
export function entryTypeOf(kind: LedgerTransactionKind, amountNpr: number): WalletEntryType {
  switch (kind) {
    case 'ORDER_SETTLEMENT':
      // The only settlement that debits a vendor is COD self-delivery's commission (SPEC §5).
      return amountNpr < 0 ? 'COD_COMMISSION_DEBIT' : 'ORDER_PAYOUT';
    case 'VENDOR_TOP_UP':
      return 'TOP_UP';
    case 'ADJUSTMENT':
    case 'PAYMENT_CAPTURE':
      // A capture never touches a vendor wallet; if one ever did, it is a correction to review.
      return 'ADJUSTMENT';
    case 'VENDOR_PAYOUT':
      return 'PAYOUT_HOLD';
    case 'VENDOR_PAYOUT_REVERSAL':
      return 'PAYOUT_REVERSAL';
    case 'AD_PURCHASE':
      return 'AD_CHARGE';
    case 'AD_BUDGET_RELEASE':
    case 'AD_REFUND':
      return 'AD_REFUND';
  }
}
