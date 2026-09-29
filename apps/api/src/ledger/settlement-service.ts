import { orders, type Database, type Transaction } from '@hamro-pasal/db';
import type { Order } from '@hamro-pasal/shared-types';
import { eq } from 'drizzle-orm';

import type { LedgerService, PostResult } from './ledger-service';
import { planPaymentCapture, planSettlement } from './settlement-plan';

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
  capturePayment(orderId: string): Promise<PostResult> {
    return this.db.transaction(async (tx) =>
      this.capturePaymentInTransaction(tx, await lockOrder(tx, orderId)),
    );
  }

  /**
   * Capture inside the caller's transaction. The caller must already hold the order row lock
   * (SELECT ... FOR UPDATE), e.g. a gateway webhook that verified the amount under that lock.
   */
  async capturePaymentInTransaction(tx: Transaction, order: Order): Promise<PostResult> {
    if (order.payment_status === 'FAILED') {
      throw new SettlementNotAllowedError(order.id, 'payment has FAILED');
    }
    const result = await this.ledger.post(tx, {
      kind: 'PAYMENT_CAPTURE',
      idempotencyKey: `payment-capture:${order.id}`,
      orderId: order.id,
      description: `${order.payment_method} payment captured into escrow`,
      postings: planPaymentCapture(order),
    });
    if (order.payment_status !== 'PAID') {
      await tx.update(orders).set({ payment_status: 'PAID' }).where(eq(orders.id, order.id));
    }
    return result;
  }

  /**
   * Splits the order's money to vendor, driver and platform. Allowed strictly once the order is
   * DELIVERED. A DISPUTED order stays frozen in escrow until arbitration.
   */
  settleOrder(orderId: string): Promise<SettlementResult> {
    return this.db.transaction(async (tx) => {
      const order = await lockOrder(tx, orderId);
      if (order.state !== 'DELIVERED') {
        throw new SettlementNotAllowedError(orderId, `cannot settle in state ${order.state}`);
      }
      if (order.payment_method !== 'COD' && order.payment_status !== 'PAID') {
        throw new SettlementNotAllowedError(orderId, 'prepaid funds were never captured');
      }

      if (order.payment_method === 'COD' && order.payment_status === 'PENDING') {
        // Cash changed hands at the doorstep (SPEC delivery flow step 5).
        await tx.update(orders).set({ payment_status: 'PAID' }).where(eq(orders.id, orderId));
      }

      const postings = planSettlement(order);
      if (postings.length === 0) {
        return { status: 'nothing_to_post' } as const;
      }
      return this.ledger.post(tx, {
        kind: 'ORDER_SETTLEMENT',
        idempotencyKey: `order-settlement:${orderId}`,
        orderId,
        description: `${order.payment_method} / ${order.fulfillment_locked} settlement`,
        postings,
      });
    });
  }
}

async function lockOrder(tx: Transaction, orderId: string): Promise<Order> {
  const [order] = await tx.select().from(orders).where(eq(orders.id, orderId)).for('update');
  if (order === undefined) {
    throw new SettlementNotAllowedError(orderId, 'order not found');
  }
  return order;
}
