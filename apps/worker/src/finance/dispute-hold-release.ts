import {
  disputes,
  ledgerAccounts,
  ledgerEntries,
  ledgerTransactions,
  orders,
  type Database,
} from '@hamro-pasal/db';
import {
  disputeReleaseKey,
  settleDisputeHold,
  toNpr,
  type LedgerService,
} from '@hamro-pasal/ledger';
import { DISPUTE_WINDOW_HOURS } from '@hamro-pasal/shared-types';
import { and, asc, eq, isNull, ne, notExists, or, sql } from 'drizzle-orm';

/** Orders looked at per run; the next hourly run takes the rest. */
export const DISPUTE_HOLD_RELEASE_BATCH = 500;

export interface DisputeHoldReleaseSummary {
  /** Orders whose held earnings reached the wallet. */
  readonly released: number;
  readonly releasedNpr: number;
  /** Orders that were escalated (or released) in the meantime and were left alone. */
  readonly skipped: number;
}

type Outcome =
  { readonly status: 'RELEASED'; readonly amountNpr: number } | { readonly status: 'SKIPPED' };

/**
 * Step 7.3 (SPEC core 6, verification 25): hourly on the maintenance queue. A prepaid order whose
 * conversation window closed (`delivered_at + 168 h`, on the database clock) without an escalation
 * has its held earnings moved to the vendor's wallet, and its conversation becomes CLOSED (a row
 * is created CLOSED when nobody chatted).
 *
 * One transaction per order, in the lock order of every other move of an order's money: the order
 * row FOR UPDATE, then the re-check (still DELIVERED, past the window, no escalation, no release),
 * then the conversation row, then the journal through LedgerService (so a release can lift a debt
 * suspension). An escalation takes the same order row lock (SPEC edge case 19): committed first,
 * the money stays held; arriving after this release, it is refused as outside the window. The
 * journal's idempotency key (`dispute-release:<order>`) makes a second release impossible.
 *
 * Only orders with something held are candidates: an order delivered before the hold existed was
 * credited to the wallet at delivery and is never touched here.
 */
export class DisputeHoldReleaseService {
  constructor(
    private readonly db: Database,
    private readonly ledger: LedgerService,
    private readonly batchSize = DISPUTE_HOLD_RELEASE_BATCH,
  ) {}

  async run(): Promise<DisputeHoldReleaseSummary> {
    const candidates = await this.db
      .selectDistinct({ id: orders.id, deliveredAt: orders.delivered_at })
      .from(orders)
      .innerJoin(ledgerTransactions, eq(ledgerTransactions.order_id, orders.id))
      .innerJoin(ledgerEntries, eq(ledgerEntries.transaction_id, ledgerTransactions.id))
      .innerJoin(
        ledgerAccounts,
        and(
          eq(ledgerAccounts.id, ledgerEntries.account_id),
          eq(ledgerAccounts.hold_vendor_id, orders.vendor_id),
        ),
      )
      .leftJoin(disputes, eq(disputes.order_id, orders.id))
      .where(
        and(
          eq(orders.state, 'DELIVERED'),
          ne(orders.payment_method, 'COD'),
          sql`${orders.delivered_at} + make_interval(hours => ${DISPUTE_WINDOW_HOURS}) <= clock_timestamp()`,
          or(isNull(disputes.id), eq(disputes.status, 'OPEN')),
          notExists(
            this.db
              .select({ id: ledgerTransactions.id })
              .from(ledgerTransactions)
              .where(
                eq(
                  ledgerTransactions.idempotency_key,
                  sql`'dispute-release:' || ${orders.id}::text`,
                ),
              ),
          ),
        ),
      )
      .orderBy(asc(orders.delivered_at), asc(orders.id))
      .limit(this.batchSize);

    let released = 0;
    let releasedNpr = 0;
    let skipped = 0;
    for (const { id } of candidates) {
      const outcome = await this.releaseOne(id);
      if (outcome.status === 'RELEASED') {
        released += 1;
        releasedNpr += outcome.amountNpr;
      } else {
        skipped += 1;
      }
    }
    return { released, releasedNpr: Math.round(releasedNpr * 100) / 100, skipped };
  }

  /** One order, in its own transaction. Exported through `run`; public for the tests. */
  releaseOne(orderId: string): Promise<Outcome> {
    return this.db.transaction(async (tx) => {
      const [order] = await tx
        .select({
          id: orders.id,
          vendorId: orders.vendor_id,
          customerId: orders.customer_id,
          state: orders.state,
          paymentMethod: orders.payment_method,
          windowClosed: sql<boolean>`${orders.delivered_at} IS NOT NULL
            AND ${orders.delivered_at} + make_interval(hours => ${DISPUTE_WINDOW_HOURS}) <= clock_timestamp()`.mapWith(
            Boolean,
          ),
        })
        .from(orders)
        .where(eq(orders.id, orderId))
        .for('update');
      if (order?.state !== 'DELIVERED' || order.paymentMethod === 'COD' || !order.windowClosed) {
        return { status: 'SKIPPED' };
      }
      const [conversation] = await tx
        .select()
        .from(disputes)
        .where(eq(disputes.order_id, orderId))
        .for('update');
      if (conversation !== undefined && conversation.status !== 'OPEN')
        return { status: 'SKIPPED' };
      const [done] = await tx
        .select({ id: ledgerTransactions.id })
        .from(ledgerTransactions)
        .where(eq(ledgerTransactions.idempotency_key, disputeReleaseKey(orderId)));
      if (done !== undefined) return { status: 'SKIPPED' };

      const money = await settleDisputeHold(tx, this.ledger, {
        orderId,
        vendorId: order.vendorId,
        refundPaisa: 0,
      });
      if (money.releaseTransactionId === null) return { status: 'SKIPPED' };

      const closed = {
        status: 'CLOSED' as const,
        resolved_at: new Date(),
        hold_release_transaction_id: money.releaseTransactionId,
      };
      if (conversation === undefined) {
        await tx.insert(disputes).values({ order_id: orderId, ...closed });
      } else {
        await tx.update(disputes).set(closed).where(eq(disputes.id, conversation.id));
      }
      return { status: 'RELEASED', amountNpr: toNpr(money.split.releasePaisa) };
    });
  }
}
