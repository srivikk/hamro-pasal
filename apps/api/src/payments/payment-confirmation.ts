import { orders, type Database } from '@hamro-pasal/db';
import type { Order, PaymentStatus } from '@hamro-pasal/shared-types';
import { and, eq } from 'drizzle-orm';

import type { CheckoutService } from '../checkout/checkout-service';
import { InsufficientStockError, ReservationExpiredError } from '../inventory/errors';
import { toPaisa } from '../ledger/money';
import type { SettlementService } from '../ledger/settlement-service';
import type { Gateway } from './gateway-http';

/** SPEC: the gateway amount must match the DB snapshot within +/-0.01 NPR (1 paisa). */
export const AMOUNT_TOLERANCE_PAISA = 1;

export class PaymentNotFoundError extends Error {
  constructor(
    readonly gateway: Gateway,
    readonly gatewayRef: string,
  ) {
    super(`No ${gateway} payment ${gatewayRef}`);
    this.name = 'PaymentNotFoundError';
  }
}

export class PaymentAmountMismatchError extends Error {
  constructor(
    readonly orderId: string,
    readonly expectedPaisa: number,
    readonly paidPaisa: number,
  ) {
    super(`Order ${orderId}: paid ${String(paidPaisa)} paisa, expected ${String(expectedPaisa)}`);
    this.name = 'PaymentAmountMismatchError';
  }
}

/**
 * The gateway confirmed a payment, but the 600 s lock had already expired (or stock vanished),
 * so the order cannot be placed. The money is in escrow and must be refunded.
 */
export class PaidAfterLockExpiredError extends Error {
  constructor(readonly orderId: string) {
    super(`Order ${orderId} was paid after its checkout session expired; refund required`);
    this.name = 'PaidAfterLockExpiredError';
  }
}

export interface ConfirmedPayment {
  readonly orderId: string;
  readonly orderState: Order['state'];
  readonly paymentStatus: PaymentStatus;
  /** false when this confirmation was a duplicate of one already credited. */
  readonly newlyCaptured: boolean;
}

export function orderTotalPaisa(order: Pick<Order, 'subtotal' | 'delivery_fee'>): number {
  return toPaisa(order.subtotal) + toPaisa(order.delivery_fee);
}

/**
 * Shared tail of the eSewa and Khalti verification flows, after the gateway itself was verified
 * (eSewa HMAC signature / Khalti server-side lookup):
 *
 *  1. One DB transaction locks the order row with SELECT ... FOR UPDATE (SPEC edge case 3), checks
 *     the amount against the snapshot (+/-0.01 NPR), and credits SYSTEM_ESCROW once. Concurrent or
 *     replayed callbacks serialise on the lock and find the order already PAID.
 *  2. After commit, the 600 s inventory lock is claimed and the order becomes PLACED (SPEC §3).
 */
export class PaymentConfirmationService {
  constructor(
    private readonly db: Database,
    private readonly settlement: SettlementService,
    private readonly checkout: CheckoutService,
  ) {}

  async confirm(input: {
    readonly gateway: Gateway;
    readonly gatewayRef: string;
    readonly paidPaisa: number;
  }): Promise<ConfirmedPayment> {
    const { order, newlyCaptured } = await this.db.transaction(async (tx) => {
      const [locked] = await tx
        .select()
        .from(orders)
        .where(
          and(
            eq(orders.payment_method, input.gateway),
            eq(orders.payment_gateway_ref, input.gatewayRef),
          ),
        )
        .for('update');
      if (locked === undefined) {
        throw new PaymentNotFoundError(input.gateway, input.gatewayRef);
      }
      const expected = orderTotalPaisa(locked);
      if (Math.abs(input.paidPaisa - expected) > AMOUNT_TOLERANCE_PAISA) {
        throw new PaymentAmountMismatchError(locked.id, expected, input.paidPaisa);
      }
      if (locked.payment_status === 'PAID') {
        return { order: locked, newlyCaptured: false };
      }
      await this.settlement.capturePaymentInTransaction(tx, locked);
      return { order: { ...locked, payment_status: 'PAID' as const }, newlyCaptured: true };
    });

    const placed = await this.placeIfPending(order);
    return {
      orderId: placed.id,
      orderState: placed.state,
      paymentStatus: placed.payment_status,
      newlyCaptured,
    };
  }

  /** Claims the order's inventory lock; a duplicate confirmation finds the order already placed. */
  private async placeIfPending(order: Order): Promise<Order> {
    if (order.state !== 'PENDING_PAYMENT' || order.reservation_id === null) {
      return order;
    }
    try {
      return (
        await this.checkout.claim({
          orderId: order.id,
          vendorId: order.vendor_id,
          reservationId: order.reservation_id,
        })
      ).order;
    } catch (error: unknown) {
      const current = await this.reload(order.id);
      if (current.state !== 'PENDING_PAYMENT') {
        return current; // a concurrent confirmation placed it first
      }
      if (!(error instanceof ReservationExpiredError || error instanceof InsufficientStockError)) {
        throw error;
      }
      // Paid, but the lock expired or stock no longer covers it: the order cannot be placed.
      await this.db
        .update(orders)
        .set({ state: 'FAILED' })
        .where(and(eq(orders.id, order.id), eq(orders.state, 'PENDING_PAYMENT')));
      throw new PaidAfterLockExpiredError(order.id);
    }
  }

  private async reload(orderId: string): Promise<Order> {
    const [order] = await this.db.select().from(orders).where(eq(orders.id, orderId));
    if (order === undefined) throw new Error(`Order ${orderId} disappeared`);
    return order;
  }
}
