import {
  orderAddresses,
  orderItems,
  orders,
  vendors,
  type Database,
  type Transaction,
} from '@hamro-pasal/db';
import {
  DELIVERY_OTP_MAX_ATTEMPTS,
  type FulfillmentMode,
  type Order,
  type OrderAddress,
  type OrderItem,
  type OrderState,
} from '@hamro-pasal/shared-types';
import { compare } from 'bcryptjs';
import { and, asc, eq, inArray, isNull, or, sql } from 'drizzle-orm';

import { OrderNotFoundError } from '../checkout/checkout-service';
import type { SettlementService } from '../ledger/settlement-service';
import type { DeliveryOtpAttempts } from './delivery-otp-attempts';
import { enqueueOrderStateChanged } from './order-events';

/** The code the rider typed does not match the order's delivery OTP. */
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

/** Orders a platform rider carries. SELF_DELIVERY orders are handed over by the vendor's staff. */
export const FLEET_FULFILLMENT_MODES = [
  'PLATFORM_FLEET',
  'EMERGENCY_FLEET',
] as const satisfies FulfillmentMode[];

/** A safety cap on the rider's list. */
export const DRIVER_ACTIVE_ORDERS_LIMIT = 100;

export interface DriverOrder {
  readonly order: Order;
  readonly vendorBusinessName: string;
  readonly items: readonly OrderItem[];
  readonly address: OrderAddress | null;
}

export interface DeliveryResult {
  readonly order: Order;
  /** true when this rider had already delivered the order (a retried request). */
  readonly replayed: boolean;
}

/**
 * The platform rider's side of an order (delivery partner flow, steps 3–5). A rider may see and
 * deliver a fleet order that is theirs or not yet claimed by any rider (nothing assigns gigs yet);
 * delivering records them as its driver. Anyone else's order is ORDER_NOT_FOUND.
 */
export class DriverOrderService {
  constructor(
    private readonly db: Database,
    private readonly settlement: SettlementService,
    private readonly attempts: DeliveryOtpAttempts,
  ) {}

  /** GET /api/driver/orders: fleet orders OUT_FOR_DELIVERY, oldest placement first. */
  async listActive(driverUserId: string): Promise<DriverOrder[]> {
    const rows = await this.db
      .select({ order: orders, vendorBusinessName: vendors.business_name })
      .from(orders)
      .innerJoin(vendors, eq(vendors.id, orders.vendor_id))
      .where(and(eq(orders.state, 'OUT_FOR_DELIVERY'), riderMayCarry(driverUserId)))
      .orderBy(asc(orders.placed_at), asc(orders.id))
      .limit(DRIVER_ACTIVE_ORDERS_LIMIT);
    if (rows.length === 0) return [];

    const ids = rows.map((row) => row.order.id);
    const [items, addresses] = await Promise.all([
      this.db
        .select()
        .from(orderItems)
        .where(inArray(orderItems.order_id, ids))
        .orderBy(asc(orderItems.created_at), asc(orderItems.id)),
      this.db.select().from(orderAddresses).where(inArray(orderAddresses.order_id, ids)),
    ]);
    return rows.map(({ order, vendorBusinessName }) => ({
      order,
      vendorBusinessName,
      items: items.filter((item) => item.order_id === order.id),
      address: addresses.find((address) => address.order_id === order.id) ?? null,
    }));
  }

  /**
   * POST /api/driver/orders/:id/deliver (customer journey 10, driver flow step 5). In one
   * transaction under `SELECT … FOR UPDATE` on the order:
   *   - the order must be OUT_FOR_DELIVERY, and not locked by DELIVERY_OTP_MAX_ATTEMPTS wrong
   *     codes (429 until the lockout ends, even for the right code);
   *   - the code is compared with the bcrypt hash; a wrong one is counted (401, or 429 when it
   *     is the one that reaches the limit);
   *   - a match: DELIVERED, `delivered_at = now()`, the hash erased (the code cannot be replayed),
   *     this rider recorded as the driver, escrow settled (SPEC: "Escrow releases") and
   *     `order.state_changed` written, all in the same commit.
   * The rider who delivered an order gets the same success again on a retry.
   */
  async deliver(driverUserId: string, orderId: string, otp: string): Promise<DeliveryResult> {
    const result = await this.db.transaction(async (tx) => {
      const order = await this.lockCarriableOrder(tx, driverUserId, orderId);
      if (order.state === 'DELIVERED' && order.driver_user_id === driverUserId) {
        return { order, replayed: true };
      }
      if (order.state !== 'OUT_FOR_DELIVERY')
        throw new OrderNotDeliverableError(orderId, order.state);

      const lockedMs = await this.attempts.lockedForMs(orderId);
      if (lockedMs !== null) throw new DeliveryOtpLockedError(orderId, toSeconds(lockedMs));

      if (order.delivery_otp === null) {
        throw new Error(`Order ${orderId} is out for delivery without a delivery code`);
      }
      if (!(await compare(otp, order.delivery_otp))) {
        const { failures, ttlMs } = await this.attempts.recordFailure(orderId);
        if (failures >= DELIVERY_OTP_MAX_ATTEMPTS) {
          throw new DeliveryOtpLockedError(orderId, toSeconds(ttlMs));
        }
        throw new InvalidDeliveryOtpError(orderId, DELIVERY_OTP_MAX_ATTEMPTS - failures);
      }

      const [delivered] = await tx
        .update(orders)
        .set({
          state: 'DELIVERED',
          delivered_at: sql`now()`,
          delivery_otp: null,
          driver_user_id: driverUserId,
        })
        .where(eq(orders.id, orderId))
        .returning();
      if (delivered === undefined) throw new Error(`Order ${orderId} disappeared during delivery`);
      const { order: settled } = await this.settlement.settleOrderInTransaction(tx, delivered);
      await enqueueOrderStateChanged(tx, order.state, settled);
      return { order: settled, replayed: false };
    });

    if (!result.replayed) {
      try {
        await this.attempts.clear(orderId);
      } catch {
        // Harmless: the order is delivered, and the counter expires with its lockout window.
      }
    }
    return result;
  }

  /** The order row, locked `FOR UPDATE`, if this rider may carry it; otherwise 404. */
  private async lockCarriableOrder(
    tx: Transaction,
    driverUserId: string,
    orderId: string,
  ): Promise<Order> {
    const [order] = await tx
      .select()
      .from(orders)
      .where(and(eq(orders.id, orderId), riderMayCarry(driverUserId)))
      .for('update');
    if (order === undefined) throw new OrderNotFoundError(orderId);
    return order;
  }
}

/** A fleet order that is this rider's, or that no rider has claimed yet. */
function riderMayCarry(driverUserId: string) {
  return and(
    inArray(orders.fulfillment_locked, FLEET_FULFILLMENT_MODES),
    or(isNull(orders.driver_user_id), eq(orders.driver_user_id, driverUserId)),
  );
}

function toSeconds(ms: number): number {
  return Math.max(1, Math.ceil(ms / 1000));
}
