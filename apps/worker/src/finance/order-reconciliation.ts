import {
  ledgerAccounts,
  ledgerEntries,
  ledgerTransactions,
  orders,
  type Database,
  type Transaction,
} from '@hamro-pasal/db';
import {
  orderSettlementKey,
  planSettlement,
  toNpr,
  toPaisa,
  type SettlementService,
} from '@hamro-pasal/ledger';
import type { Order } from '@hamro-pasal/shared-types';
import { and, asc, eq, gt, isNull, sql } from 'drizzle-orm';

/** A DELIVERED order whose settlement is now verified and stamped `reconciled_at`. */
export interface ReconciledOrder {
  readonly status: 'RECONCILED';
  readonly orderId: string;
  readonly vendorId: string;
  /** What the settlement journal posted to the vendor wallet (negative for a COD commission debit). */
  readonly vendorWalletNpr: number;
  readonly commissionNpr: number;
  /** True when this run posted the settlement journal (it was missing). */
  readonly settlementPosted: boolean;
  readonly reconciledAt: Date;
}

export type DiscrepancyReason =
  /** The journal exists but its vendor posting is not what the order snapshot gives. */
  | 'SETTLEMENT_MISMATCH'
  /** No journal, and none could be posted (no rider, payment never captured, …). */
  | 'SETTLEMENT_FAILED';

/** A DELIVERED order left unreconciled for a human to look at; the next run tries it again. */
export interface ReconciliationDiscrepancy {
  readonly status: 'DISCREPANCY';
  readonly orderId: string;
  readonly vendorId: string | null;
  readonly reason: DiscrepancyReason;
  readonly expectedVendorWalletNpr: number | null;
  readonly actualVendorWalletNpr: number | null;
  readonly message: string;
}

type Outcome = ReconciledOrder | ReconciliationDiscrepancy | { readonly status: 'SKIPPED' };

export interface ReconciliationRun {
  readonly reconciled: readonly ReconciledOrder[];
  readonly discrepancies: readonly ReconciliationDiscrepancy[];
}

class SettlementMismatch extends Error {
  constructor(
    readonly vendorId: string,
    readonly expectedPaisa: number,
    readonly actualPaisa: number,
  ) {
    super(
      `settlement journal posted ${String(toNpr(actualPaisa))} NPR to the vendor, the order gives ${String(toNpr(expectedPaisa))} NPR`,
    );
    this.name = 'SettlementMismatch';
  }
}

/**
 * The `ORDER_RECONCILIATION` midnight task (Phase 22, SPEC §5).
 *
 * Money moves when an order is delivered: the handoff settles escrow in its own commit
 * (SettlementService, journal `order-settlement:<order>`). This job never credits a vendor a second
 * time. For every DELIVERED order without `reconciled_at` it runs one transaction that:
 *   - locks the order row (`FOR UPDATE`) and re-checks it is still DELIVERED and unreconciled, so two
 *     runs (a retried job, two workers) cannot both take it;
 *   - works out the vendor's cut from the order snapshot (planSettlement: subtotal minus the stored
 *     `platform_commission_amount`, plus the delivery fee when the shop delivered);
 *   - posts the settlement journal if it is missing. The journal's idempotency key is the order's,
 *     so it can exist at most once whoever posts it;
 *   - compares the journal's vendor posting with that cut, and only when they agree stamps
 *     `reconciled_at`.
 * A mismatch, or a settlement that cannot be posted, rolls that order's transaction back and is
 * reported; the other orders are unaffected and the next run tries it again.
 */
export class OrderReconciliationService {
  constructor(
    private readonly db: Database,
    private readonly settlement: Pick<SettlementService, 'settleOrderInTransaction'>,
    private readonly batchSize = 200,
  ) {}

  async reconcileDeliveredOrders(): Promise<ReconciliationRun> {
    const reconciled: ReconciledOrder[] = [];
    const discrepancies: ReconciliationDiscrepancy[] = [];
    let after: string | null = null;

    for (;;) {
      // Keyset on the id, so an order that stays unreconciled (a discrepancy) is passed, not rescanned.
      const batch: { id: string }[] = await this.db
        .select({ id: orders.id })
        .from(orders)
        .where(
          and(
            eq(orders.state, 'DELIVERED'),
            isNull(orders.reconciled_at),
            after === null ? undefined : gt(orders.id, after),
          ),
        )
        .orderBy(asc(orders.id))
        .limit(this.batchSize);
      const last = batch.at(-1);
      if (last === undefined) break;
      after = last.id;

      for (const { id } of batch) {
        const outcome = await this.reconcileOrder(id);
        if (outcome.status === 'RECONCILED') reconciled.push(outcome);
        if (outcome.status === 'DISCREPANCY') discrepancies.push(outcome);
      }
    }
    return { reconciled, discrepancies };
  }

  /** One order, one transaction. */
  async reconcileOrder(orderId: string): Promise<Outcome> {
    try {
      return await this.db.transaction((tx) => this.reconcileInTransaction(tx, orderId));
    } catch (error) {
      if (error instanceof SettlementMismatch) {
        return {
          status: 'DISCREPANCY',
          orderId,
          vendorId: error.vendorId,
          reason: 'SETTLEMENT_MISMATCH',
          expectedVendorWalletNpr: toNpr(error.expectedPaisa),
          actualVendorWalletNpr: toNpr(error.actualPaisa),
          message: error.message,
        };
      }
      return {
        status: 'DISCREPANCY',
        orderId,
        vendorId: null,
        reason: 'SETTLEMENT_FAILED',
        expectedVendorWalletNpr: null,
        actualVendorWalletNpr: null,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async reconcileInTransaction(tx: Transaction, orderId: string): Promise<Outcome> {
    const [order] = await tx.select().from(orders).where(eq(orders.id, orderId)).for('update');
    if (order?.state !== 'DELIVERED' || order.reconciled_at !== null) {
      return { status: 'SKIPPED' };
    }

    const expectedPaisa = vendorWalletPaisa(order);
    const settlementPosted = (await settlementJournalId(tx, order.id)) === null;
    if (settlementPosted) {
      // Normally the delivery already did this; a no-op plan (nothing to move) still marks COD paid.
      await this.settlement.settleOrderInTransaction(tx, order);
    }

    const actualPaisa = await postedVendorWalletPaisa(tx, order);
    if (actualPaisa !== expectedPaisa) {
      throw new SettlementMismatch(order.vendor_id, expectedPaisa, actualPaisa);
    }

    const [stamped] = await tx
      .update(orders)
      .set({ reconciled_at: sql`now()` })
      .where(eq(orders.id, order.id))
      .returning({ reconciledAt: orders.reconciled_at });
    if (stamped?.reconciledAt == null) throw new Error(`Order ${order.id} was not stamped`);

    return {
      status: 'RECONCILED',
      orderId: order.id,
      vendorId: order.vendor_id,
      vendorWalletNpr: toNpr(actualPaisa),
      commissionNpr: order.platform_commission_amount,
      settlementPosted,
      reconciledAt: stamped.reconciledAt,
    };
  }
}

/** What the order's settlement must post to its vendor's wallet, from the order snapshot. */
export function vendorWalletPaisa(order: Order): number {
  return planSettlement(order)
    .filter(
      ({ account }) => account.type === 'VENDOR_WALLET' && account.vendorId === order.vendor_id,
    )
    .reduce((total, posting) => total + posting.amountPaisa, 0);
}

async function settlementJournalId(tx: Transaction, orderId: string): Promise<string | null> {
  const [journal] = await tx
    .select({ id: ledgerTransactions.id })
    .from(ledgerTransactions)
    .where(eq(ledgerTransactions.idempotency_key, orderSettlementKey(orderId)));
  return journal?.id ?? null;
}

/** What the settlement journal did post to the vendor's wallet (0 without a journal or a posting). */
async function postedVendorWalletPaisa(tx: Transaction, order: Order): Promise<number> {
  const [posted] = await tx
    .select({ total: sql<number>`coalesce(sum(${ledgerEntries.amount_npr}), 0)`.mapWith(Number) })
    .from(ledgerEntries)
    .innerJoin(ledgerTransactions, eq(ledgerTransactions.id, ledgerEntries.transaction_id))
    .innerJoin(ledgerAccounts, eq(ledgerAccounts.id, ledgerEntries.account_id))
    .where(
      and(
        eq(ledgerTransactions.idempotency_key, orderSettlementKey(order.id)),
        eq(ledgerAccounts.vendor_id, order.vendor_id),
      ),
    );
  return toPaisa(posted?.total ?? 0);
}
