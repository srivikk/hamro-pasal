import { orders, type Transaction } from '@hamro-pasal/db';
import { DELIVERY_OTP_MAX_ATTEMPTS, type Order, type OrderState } from '@hamro-pasal/shared-types';
import { compare } from 'bcryptjs';
import { eq, sql } from 'drizzle-orm';

import {
  chargePerOrderAdPremium,
  generateFiscalInvoice,
  type LedgerService,
} from '@hamro-pasal/ledger';

import type { SettlementService } from '../ledger/settlement-service';
import type { DeliveryOtpAttempts } from './delivery-otp-attempts';
import { enqueueOrderStateChanged } from './order-events';

/** The code typed at the door does not match the order's delivery OTP. */
export class InvalidDeliveryOtpError extends Error {
  constructor(
    readonly orderId: string,
    readonly attemptsRemaining: number,
  ) {
    super(`Wrong delivery code for order ${orderId}`);
    this.name = 'InvalidDeliveryOtpError';
  }
}

/** Too many wrong codes for this order: no code is checked until the lockout ends. */
export class DeliveryOtpLockedError extends Error {
  constructor(
    readonly orderId: string,
    readonly retryAfterSeconds: number,
  ) {
    super(`Order ${orderId} is locked after ${String(DELIVERY_OTP_MAX_ATTEMPTS)} wrong codes`);
    this.name = 'DeliveryOtpLockedError';
  }
}

/** Only an order out for delivery can be handed over. */
export class OrderNotDeliverableError extends Error {
  constructor(
    readonly orderId: string,
    readonly state: OrderState,
  ) {
    super(`Order ${orderId} cannot be delivered in state ${state}`);
    this.name = 'OrderNotDeliverableError';
  }
}

export interface DeliveryResult {
  readonly order: Order;
  /** true when the same party had already delivered the order (a retried request). */
  readonly replayed: boolean;
}

/**
 * The doorstep handoff (customer journey 10), shared by the platform rider (driver flow step 5)
 * and the vendor's own staff (vendor flow step 9) so both run exactly the same checks. The caller
 * finds the order it may hand over and locks it `FOR UPDATE` in `tx`; then, still in `tx`:
 *   - the order must be OUT_FOR_DELIVERY, and not locked by DELIVERY_OTP_MAX_ATTEMPTS wrong codes
 *     (429 until the lockout ends, even for the right code);
 *   - the code is compared with the bcrypt hash; a wrong one is counted in Redis (401, or 429 when
 *     it is the one that reaches the limit);
 *   - a match: DELIVERED, `delivered_at = now()`, the hash erased (the code cannot be replayed),
 *     the rider recorded (fleet orders), escrow settled (SPEC: "Escrow releases"), the per-order
 *     ad premium charged (SPEC core 8) and `order.state_changed` written, all in the caller's
 *     commit.
 *
 * Locks, in order: the order row (the caller), the vendor row and the ledger accounts (the
 * settlement journal), then the vendor row again, the ad purchase row and the ledger accounts
 * (the ad premium), and last the seller's invoice sequence row (the fiscal invoice, SPEC core
 * 10). Every ad path takes vendor, purchase, accounts in that order, and holds the vendor row
 * before any purchase row; nothing is locked after a sequence row.
 * After that commit the caller runs `afterCommit`, which clears the failure counter.
 */
export class DeliveryHandoff {
  constructor(
    private readonly settlement: SettlementService,
    private readonly attempts: DeliveryOtpAttempts,
    private readonly ledger: LedgerService,
  ) {}

  async handOver(
    tx: Transaction,
    order: Order,
    otp: string,
    driverUserId: string | null,
  ): Promise<Order> {
    if (order.state !== 'OUT_FOR_DELIVERY')
      throw new OrderNotDeliverableError(order.id, order.state);

    const lockedMs = await this.attempts.lockedForMs(order.id);
    if (lockedMs !== null) throw new DeliveryOtpLockedError(order.id, toSeconds(lockedMs));

    if (order.delivery_otp === null) {
      throw new Error(`Order ${order.id} is out for delivery without a delivery code`);
    }
    if (!(await compare(otp, order.delivery_otp))) {
      const { failures, ttlMs } = await this.attempts.recordFailure(order.id);
      if (failures >= DELIVERY_OTP_MAX_ATTEMPTS) {
        throw new DeliveryOtpLockedError(order.id, toSeconds(ttlMs));
      }
      throw new InvalidDeliveryOtpError(order.id, DELIVERY_OTP_MAX_ATTEMPTS - failures);
    }

    const [delivered] = await tx
      .update(orders)
      .set({
        state: 'DELIVERED',
        delivered_at: sql`now()`,
        delivery_otp: null,
        ...(driverUserId === null ? {} : { driver_user_id: driverUserId }),
      })
      .where(eq(orders.id, order.id))
      .returning();
    if (delivered === undefined) throw new Error(`Order ${order.id} disappeared during delivery`);
    const { order: settled } = await this.settlement.settleOrderInTransaction(tx, delivered);
    // After the settlement, so a Model B shop's fee comes out of a wallet this order has just
    // credited. On a cash order it can take the wallet negative, as the commission does; the
    // debt suspension rule then applies (decided 2026-10-08). A paused ad is audited inside.
    await chargePerOrderAdPremium(tx, this.ledger, settled.id, settled.vendor_id);
    // The fiscal invoice, in the delivery's own commit: a delivered order has exactly one, and a
    // delivery that rolls back takes no Bill Number. A seller without a PAN (swept for
    // compliance, finishing its open orders) gets none. An invoice whose total would not equal
    // what the customer paid throws, and the order is not delivered.
    await generateFiscalInvoice(tx, settled);
    await enqueueOrderStateChanged(tx, order.state, settled);
    return settled;
  }

  /** Run after the delivering transaction committed. */
  async afterCommit(result: DeliveryResult): Promise<void> {
    if (result.replayed) return;
    try {
      await this.attempts.clear(result.order.id);
    } catch {
      // Harmless: the order is delivered, and the counter expires with its lockout window.
    }
  }
}

function toSeconds(ms: number): number {
  return Math.max(1, Math.ceil(ms / 1000));
}
