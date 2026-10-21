import { orders, type Database, type Transaction } from '@hamro-pasal/db';
import type { Order } from '@hamro-pasal/shared-types';
import { eq } from 'drizzle-orm';

import type { LedgerService, PostResult } from './ledger-service';
import {
  planOrderFee,
  planPaymentCapture,
  planPaymentReversal,
  planSettlement,
} from './settlement-plan';

export class SettlementNotAllowedError extends Error {
  constructor(
    readonly orderId: string,
    reason: string,
  ) {
    super(`Order ${orderId}: ${reason}`);
    this.name = 'SettlementNotAllowedError';
  }
}

export type SettlementResult = PostResult | { readonly status: 'nothing_to_post' };

/**
 * Order-level money movements (SPEC §5). Each runs in one DB transaction that first locks the
 * order row with SELECT ... FOR UPDATE (SPEC edge case 3), so duplicate webhooks and
 * concurrent settlement attempts serialise; the journal's idempotency key makes the replay a
 * no-op.
 */
export class SettlementService {
  constructor(
    private readonly db: Database,
    private readonly ledger: LedgerService,
  ) {}

  /** Gateway payment verified: GATEWAY_CLEARING -> SYSTEM_ESCROW, and the order is marked PAID. */
  capturePayment(orderId: string): Promise<SettlementResult> {
    return this.db.transaction(async (tx) =>
      this.capturePaymentInTransaction(tx, await lockOrder(tx, orderId)),
    );
  }

  /**
   * Capture inside the caller's transaction. The caller must already hold the order row lock
   * (SELECT ... FOR UPDATE), e.g. a gateway webhook that verified the amount under that lock.
   */
  async capturePaymentInTransaction(tx: Transaction, order: Order): Promise<SettlementResult> {
    if (order.payment_status === 'FAILED') {
      throw new SettlementNotAllowedError(order.id, 'payment has FAILED');
    }
    // A Model C gateway payment went to the shop's own merchant account: nothing to post, the
    // order is only marked PAID (2026-10-21).
    const postings = planPaymentCapture(order);
    const result: SettlementResult =
      postings.length === 0
        ? { status: 'nothing_to_post' }
        : await this.ledger.post(tx, {
            kind: order.payment_method === 'WALLET' ? 'WALLET_PAYMENT' : 'PAYMENT_CAPTURE',
            idempotencyKey: `payment-capture:${order.id}`,
            orderId: order.id,
            description:
              order.settlement_model_locked === 'DIRECT_PREPAID'
                ? `${order.payment_method} payment to the shop's prepaid balance`
                : `${order.payment_method} payment captured into escrow`,
            postings,
          });
    if (order.payment_status !== 'PAID') {
      await tx.update(orders).set({ payment_status: 'PAID' }).where(eq(orders.id, order.id));
    }
    return result;
  }

  /**
   * A paid order that could not be placed (2026-10-21): its capture posted back, so a wallet
   * payment returns to the wallet at once. The caller holds the order row.
   */
  async reversePaymentInTransaction(tx: Transaction, order: Order): Promise<SettlementResult> {
    const postings = planPaymentReversal(order);
    if (postings.length === 0) return { status: 'nothing_to_post' };
    return this.ledger.post(tx, {
      kind: 'ORDER_REFUND',
      idempotencyKey: `payment-reversal:${order.id}`,
      orderId: order.id,
      description: `${order.payment_method} payment returned: the order could not be placed`,
      postings,
    });
  }

  /**
   * Model C (2026-10-21, SPEC core 5): the platform's fee debited from the shop's prepaid balance
   * the moment the order is placed, in the placing transaction (the caller holds the order row).
   * Nothing for any other model. May suspend the shop below its Fixed Reserve (WalletService).
   */
  async debitOrderFeeInTransaction(tx: Transaction, order: Order): Promise<SettlementResult> {
    const postings = planOrderFee(order);
    if (postings.length === 0) return { status: 'nothing_to_post' };
    return this.ledger.post(tx, {
      kind: 'ORDER_FEE_DEBIT',
      idempotencyKey: `order-fee:${order.id}`,
      orderId: order.id,
      description: 'Platform commission debited at placement (prepaid model)',
      postings,
    });
  }

  /**
   * Splits the order's money to vendor, driver and platform. Allowed strictly once the order is
   * DELIVERED. A DISPUTED order stays frozen in escrow until arbitration.
   */
  settleOrder(orderId: string): Promise<SettlementResult> {
    return this.db.transaction(async (tx) => {
      const { result } = await this.settleOrderInTransaction(tx, await lockOrder(tx, orderId));
      return result;
    });
  }

  /**
   * Settlement inside the caller's transaction, which must already hold the order row lock and
   * have moved it to DELIVERED (the driver's OTP handoff does both in one commit). Returns the
   * order as it is after settlement: a COD order becomes PAID here.
   */
  async settleOrderInTransaction(
    tx: Transaction,
    order: Order,
  ): Promise<{ readonly result: SettlementResult; readonly order: Order }> {
    if (order.state !== 'DELIVERED') {
      throw new SettlementNotAllowedError(order.id, `cannot settle in state ${order.state}`);
    }
    if (order.payment_method !== 'COD' && order.payment_status !== 'PAID') {
      throw new SettlementNotAllowedError(order.id, 'prepaid funds were never captured');
    }

    let settled = order;
    if (order.payment_method === 'COD' && order.payment_status === 'PENDING') {
      // Cash changed hands at the doorstep (SPEC delivery flow step 5).
      const [paid] = await tx
        .update(orders)
        .set({ payment_status: 'PAID' })
        .where(eq(orders.id, order.id))
        .returning();
      if (paid === undefined) throw new SettlementNotAllowedError(order.id, 'order not found');
      settled = paid;
    }

    const postings = planSettlement(order);
    if (postings.length === 0) {
      return { result: { status: 'nothing_to_post' }, order: settled };
    }
    const result = await this.ledger.post(tx, {
      kind: 'ORDER_SETTLEMENT',
      idempotencyKey: orderSettlementKey(order.id),
      orderId: order.id,
      description: `${order.payment_method} / ${order.fulfillment_locked} settlement`,
      postings,
    });
    return { result, order: settled };
  }
}

/** The settlement journal's idempotency key: one settlement per order, whoever posts it. */
export function orderSettlementKey(orderId: string): string {
  return `order-settlement:${orderId}`;
}

async function lockOrder(tx: Transaction, orderId: string): Promise<Order> {
  const [order] = await tx.select().from(orders).where(eq(orders.id, orderId)).for('update');
  if (order === undefined) {
    throw new SettlementNotAllowedError(orderId, 'order not found');
  }
  return order;
}
