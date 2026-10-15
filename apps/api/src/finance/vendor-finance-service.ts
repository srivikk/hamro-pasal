import { orders, payoutRequests, vendors, type Database, type Transaction } from '@hamro-pasal/db';
import { toNpr, toPaisa, type LedgerService } from '@hamro-pasal/ledger';
import {
  VENDOR_FINANCE_RECENT_LIMIT,
  type FulfillmentMode,
  type PaymentMethod,
  type PayoutRequest,
} from '@hamro-pasal/shared-types';
import { and, desc, eq, isNotNull, isNull, sql } from 'drizzle-orm';

import { adFeesDuePaisa, collectAdFeesDue } from '../marketing/ad-fees';
import { VendorAccountNotFoundError } from '../orders/vendor-order-service';
import { disputeHoldOf, pendingEscrowOf } from '../wallet/vendor-wallet-service';

export type PayoutRow = typeof payoutRequests.$inferSelect;

/** The request asks for more than the wallet holds (or the wallet is in debt). */
export class PayoutExceedsBalanceError extends Error {
  constructor(
    readonly requestedNpr: number,
    readonly availableBalanceNpr: number,
  ) {
    super(
      `A payout of ${String(requestedNpr)} NPR exceeds the available ${String(availableBalanceNpr)} NPR`,
    );
    this.name = 'PayoutExceedsBalanceError';
  }
}

/** The idempotency key was already used for a payout of a different amount. */
export class PayoutKeyReusedError extends Error {
  constructor() {
    super('This idempotency key belongs to another payout request');
    this.name = 'PayoutKeyReusedError';
  }
}

export interface ReconciledOrder {
  readonly orderId: string;
  readonly paymentMethod: PaymentMethod;
  readonly fulfillment: FulfillmentMode;
  readonly subtotalNpr: number;
  readonly deliveryFeeNpr: number;
  readonly commissionNpr: number;
  readonly vendorCutNpr: number;
  readonly walletAmountNpr: number;
  readonly deliveredAt: Date;
  readonly reconciledAt: Date;
}

export interface VendorFinanceLedger {
  readonly vendorId: string;
  readonly availableBalanceNpr: number;
  readonly pendingBalanceNpr: number;
  /** Step 7.3: delivered prepaid earnings in the 7-day dispute hold. */
  readonly disputeHoldNpr: number;
  readonly pendingPayoutNpr: number;
  readonly unreconciledOrderCount: number;
  readonly reconciledOrders: readonly ReconciledOrder[];
  readonly payouts: readonly PayoutRow[];
}

export interface PayoutRequestResult {
  readonly payout: PayoutRow;
  readonly availableBalanceNpr: number;
  readonly replayed: boolean;
}

/**
 * The vendor's earnings and withdrawals (Phase 22, SPEC §5). There is no balance table: "available"
 * is the VENDOR_WALLET ledger balance (`vendors.wallet_balance_npr`, its projection), "pending"
 * the prepaid earnings still in SYSTEM_ESCROW, and (step 7.3) the dispute hold the delivered
 * prepaid earnings waiting out their 7-day window.
 *
 * A payout is held when it is requested: under the vendor row lock the amount is checked against
 * the wallet and moved VENDOR_WALLET → PAYOUT_CLEARING by a balanced journal, in the transaction
 * that inserts the request. Concurrent requests therefore queue on that lock and each sees the
 * balance the previous one left, so together they can never exceed it.
 */
export class VendorFinanceService {
  constructor(
    private readonly db: Database,
    private readonly ledger: LedgerService,
  ) {}

  /** One REPEATABLE READ snapshot, so the balances and the lists agree with each other. */
  ledgerView(vendorUserId: string): Promise<VendorFinanceLedger> {
    return this.db.transaction(
      async (tx) => {
        const [vendor] = await tx
          .select({ id: vendors.id, walletBalanceNpr: vendors.wallet_balance_npr })
          .from(vendors)
          .where(eq(vendors.user_id, vendorUserId));
        if (vendor === undefined) throw new VendorAccountNotFoundError(vendorUserId);

        const escrow = await pendingEscrowOf(tx, vendor.id);
        const [held] = await tx
          .select({
            total: sql<number>`coalesce(sum(${payoutRequests.amount_npr}), 0)`.mapWith(Number),
          })
          .from(payoutRequests)
          .where(
            and(eq(payoutRequests.vendor_id, vendor.id), eq(payoutRequests.status, 'PENDING')),
          );
        const [unreconciled] = await tx
          .select({ count: sql<number>`count(*)`.mapWith(Number) })
          .from(orders)
          .where(
            and(
              eq(orders.vendor_id, vendor.id),
              eq(orders.state, 'DELIVERED'),
              isNull(orders.reconciled_at),
            ),
          );

        const reconciled = await tx
          .select({
            orderId: orders.id,
            paymentMethod: orders.payment_method,
            fulfillment: orders.fulfillment_locked,
            subtotal: orders.subtotal,
            deliveryFee: orders.delivery_fee,
            commission: orders.platform_commission_amount,
            // What the vendor bears: its own offer and its share of a campaign discount.
            vendorDiscount: sql<number>`"orders"."vendor_offer_discount_npr"
                + "orders"."platform_promo_vendor_share_npr"`.mapWith(Number),
            deliveredAt: orders.delivered_at,
            reconciledAt: orders.reconciled_at,
            // Drizzle writes this single-table query's columns unqualified, so the subquery names
            // the outer table itself.
            // What the order's settlement journal posted to this vendor (0 when it had nothing to
            // post, e.g. a 0 % commission COD order the shop delivered itself): to its wallet, or
            // (step 7.3, a prepaid order) to its dispute hold.
            walletAmount: sql<number>`coalesce((
                SELECT sum(e.amount_npr)
                FROM ledger_entries e
                JOIN ledger_transactions lt ON lt.id = e.transaction_id
                JOIN ledger_accounts a ON a.id = e.account_id
                WHERE lt.order_id = "orders"."id" AND lt.kind = 'ORDER_SETTLEMENT'
                  AND (a.vendor_id = "orders"."vendor_id"
                    OR a.hold_vendor_id = "orders"."vendor_id")), 0)`.mapWith(Number),
          })
          .from(orders)
          .where(and(eq(orders.vendor_id, vendor.id), isNotNull(orders.reconciled_at)))
          .orderBy(desc(orders.reconciled_at), desc(orders.id))
          .limit(VENDOR_FINANCE_RECENT_LIMIT);

        const payouts = await tx
          .select()
          .from(payoutRequests)
          .where(eq(payoutRequests.vendor_id, vendor.id))
          .orderBy(desc(payoutRequests.created_at), desc(payoutRequests.id))
          .limit(VENDOR_FINANCE_RECENT_LIMIT);

        return {
          vendorId: vendor.id,
          availableBalanceNpr: vendor.walletBalanceNpr,
          pendingBalanceNpr: escrow.totalNpr,
          disputeHoldNpr: (await disputeHoldOf(tx, vendor.id)).totalNpr,
          pendingPayoutNpr: held?.total ?? 0,
          unreconciledOrderCount: unreconciled?.count ?? 0,
          reconciledOrders: reconciled.flatMap((row): ReconciledOrder[] =>
            row.deliveredAt === null || row.reconciledAt === null
              ? []
              : [
                  {
                    orderId: row.orderId,
                    paymentMethod: row.paymentMethod,
                    fulfillment: row.fulfillment,
                    subtotalNpr: row.subtotal,
                    deliveryFeeNpr: row.deliveryFee,
                    commissionNpr: row.commission,
                    vendorCutNpr: toNpr(
                      toPaisa(row.subtotal) -
                        toPaisa(row.vendorDiscount) -
                        toPaisa(row.commission) +
                        (row.fulfillment === 'SELF_DELIVERY' ? toPaisa(row.deliveryFee) : 0),
                    ),
                    walletAmountNpr: row.walletAmount,
                    deliveredAt: row.deliveredAt,
                    reconciledAt: row.reconciledAt,
                  },
                ],
          ),
          payouts,
        };
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
  }

  requestPayout(vendorUserId: string, request: PayoutRequest): Promise<PayoutRequestResult> {
    const amountPaisa = toPaisa(request.amount_npr);

    return this.db.transaction(async (tx) => {
      // The lock every wallet journal takes (WalletService.lockStandings): requests of one vendor
      // run one after another, each against the balance the previous one committed.
      const [vendor] = await tx
        .select({ id: vendors.id, walletBalanceNpr: vendors.wallet_balance_npr })
        .from(vendors)
        .where(eq(vendors.user_id, vendorUserId))
        .for('no key update');
      if (vendor === undefined) throw new VendorAccountNotFoundError(vendorUserId);

      const [existing] = await tx
        .select()
        .from(payoutRequests)
        .where(
          and(
            eq(payoutRequests.vendor_id, vendor.id),
            eq(payoutRequests.idempotency_key, request.idempotency_key),
          ),
        );
      if (existing !== undefined) {
        if (toPaisa(existing.amount_npr) !== amountPaisa) throw new PayoutKeyReusedError();
        return { payout: existing, availableBalanceNpr: vendor.walletBalanceNpr, replayed: true };
      }

      // Ad fees the shop owes leave the wallet before a withdrawal can (SPEC core 8, Model B).
      await collectAdFeesDue(tx, this.ledger, vendor.id);
      const [swept] = await tx
        .select({ balance: vendors.wallet_balance_npr })
        .from(vendors)
        .where(eq(vendors.id, vendor.id));
      // The balance as it is (negative for a shop in debt), less any fee the wallet could not cover.
      const withdrawableNpr = toNpr(
        toPaisa(swept?.balance ?? vendor.walletBalanceNpr) - (await adFeesDuePaisa(tx, vendor.id)),
      );
      if (amountPaisa > toPaisa(withdrawableNpr)) {
        throw new PayoutExceedsBalanceError(request.amount_npr, withdrawableNpr);
      }

      const hold = await this.ledger.post(tx, {
        kind: 'VENDOR_PAYOUT',
        idempotencyKey: payoutHoldKey(vendor.id, request.idempotency_key),
        orderId: null,
        description: 'Payout requested: held for bank transfer',
        postings: [
          { account: { type: 'VENDOR_WALLET', vendorId: vendor.id }, amountPaisa: -amountPaisa },
          { account: { type: 'PAYOUT_CLEARING' }, amountPaisa },
        ],
      });
      const [payout] = await tx
        .insert(payoutRequests)
        .values({
          vendor_id: vendor.id,
          amount_npr: request.amount_npr,
          idempotency_key: request.idempotency_key,
          hold_transaction_id: hold.transactionId,
        })
        .returning();
      if (payout === undefined) throw new Error('payout request was not stored');

      return {
        payout,
        availableBalanceNpr: await walletBalanceOf(tx, vendor.id),
        replayed: false,
      };
    });
  }
}

/** Scoped to the vendor: two vendors can never collide on a client-generated key. */
export function payoutHoldKey(vendorId: string, idempotencyKey: string): string {
  return `vendor-payout:${vendorId}:${idempotencyKey}`;
}

async function walletBalanceOf(tx: Transaction, vendorId: string): Promise<number> {
  const [vendor] = await tx
    .select({ walletBalanceNpr: vendors.wallet_balance_npr })
    .from(vendors)
    .where(eq(vendors.id, vendorId));
  if (vendor === undefined) throw new Error(`Vendor ${vendorId} vanished`);
  return vendor.walletBalanceNpr;
}
