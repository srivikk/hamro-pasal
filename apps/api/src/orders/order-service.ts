import { orderAddresses, orderItems, orders, type Database } from '@hamro-pasal/db';
import { cancelPlacedOrder } from '@hamro-pasal/ledger';
import {
  ORDER_CANCELLATION_WINDOW_SECONDS,
  type Order,
  type OrderAddress,
  type OrderItem,
} from '@hamro-pasal/shared-types';
import { and, asc, eq, sql } from 'drizzle-orm';

import { OrderNotFoundError } from '../checkout/checkout-service';
import type { InventoryLockService } from '../inventory/inventory-lock-service';

/** Customer journey 8: the 60 s window, measured on the database clock, has closed. */
export class CancellationWindowExpiredError extends Error {
  constructor(readonly orderId: string) {
    super(
      `Order ${orderId} can no longer be canceled: the ${String(ORDER_CANCELLATION_WINDOW_SECONDS)} s window has closed`,
    );
    this.name = 'CancellationWindowExpiredError';
  }
}

/**
 * Only a PLACED order, or one the vendor accepted (PREPARING) inside the window, can be canceled:
 * not one still paying, nor one already out for delivery or finished.
 */
export class OrderNotCancelableError extends Error {
  constructor(
    readonly orderId: string,
    readonly state: Order['state'],
  ) {
    super(`Order ${orderId} cannot be canceled in state ${state}`);
    this.name = 'OrderNotCancelableError';
  }
}

export interface OrderDetail {
  readonly order: Order;
  readonly items: readonly OrderItem[];
  readonly address: OrderAddress | null;
}

export interface CancellationResult {
  readonly order: Order;
  /** true when the order had already been canceled by an earlier request. */
  readonly replayed: boolean;
}

export class OrderService {
  constructor(
    private readonly db: Database,
    private readonly locks: InventoryLockService,
  ) {}

  /** GET /api/orders/:id: the customer's own order with its items and delivery address. */
  async getOrder(customerId: string, orderId: string): Promise<OrderDetail> {
    const [order] = await this.db
      .select()
      .from(orders)
      .where(and(eq(orders.id, orderId), eq(orders.customer_id, customerId)));
    if (order === undefined) {
      throw new OrderNotFoundError(orderId);
    }
    const [items, [address]] = await Promise.all([
      this.db
        .select()
        .from(orderItems)
        .where(eq(orderItems.order_id, orderId))
        .orderBy(asc(orderItems.created_at), asc(orderItems.id)),
      this.db.select().from(orderAddresses).where(eq(orderAddresses.order_id, orderId)),
    ]);
    return { order, items, address: address ?? null };
  }

  /** Whether the order exists and belongs to the customer (the GET /api/orders/:id rule). */
  async isCustomerOrder(customerId: string, orderId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: orders.id })
      .from(orders)
      .where(and(eq(orders.id, orderId), eq(orders.customer_id, customerId)));
    return row !== undefined;
  }

  /**
   * POST /api/orders/:id/cancel (customer journey 8). In one transaction, under
   * SELECT ... FOR UPDATE on the order:
   *   - only the owner may cancel (anyone else gets 404, so ids cannot be probed);
   *   - only a PLACED or PREPARING order is cancelable (409 otherwise). A vendor may accept at
   *     once, but that does not shorten the customer's unskippable 60 s window (SPEC journey 8);
   *   - NOW() - placed_at must be <= 60 s, on the database clock, so time spent paying on a
   *     gateway does not eat into the window (422 otherwise);
   *   - the stock was permanently decremented when the lock was claimed, so it is added back;
   *   - a PAID order is flagged refund_required and ORDER_CANCELED_REFUND_DUE is written to the
   *     outbox in the same commit.
   * Repeating a successful cancel returns the canceled order again.
   */
  async cancel(customerId: string, orderId: string): Promise<CancellationResult> {
    const result = await this.db.transaction(async (tx) => {
      const [order] = await tx.select().from(orders).where(eq(orders.id, orderId)).for('update');
      if (order?.customer_id !== customerId) {
        throw new OrderNotFoundError(orderId);
      }
      if (order.state === 'CANCELED') {
        return { order, replayed: true };
      }

      if (order.state !== 'PLACED' && order.state !== 'PREPARING') {
        throw new OrderNotCancelableError(orderId, order.state);
      }
      // Evaluated after the row lock is held, with clock_timestamp() rather than now() (the
      // transaction start), so time spent waiting for the lock cannot extend the window.
      const [window] = await tx
        .select({
          open: sql<boolean>`${orders.placed_at} IS NOT NULL AND clock_timestamp() - ${orders.placed_at} <= make_interval(secs => ${ORDER_CANCELLATION_WINDOW_SECONDS})`.mapWith(
            Boolean,
          ),
        })
        .from(orders)
        .where(eq(orders.id, orderId));
      if (window?.open !== true) {
        throw new CancellationWindowExpiredError(orderId);
      }

      return { order: await cancelPlacedOrder(tx, order), replayed: false };
    });

    if (!result.replayed) await releaseLingeringHold(this.locks, result.order);
    return result;
  }
}

/** Moved to @hamro-pasal/ledger in step 7.3 (the worker's 5-minute auto-cancel shares it). */
export { cancelPlacedOrder };

/**
 * After a cancellation commits. Claiming the lock already deleted it; this only clears a hold whose
 * delete failed then. The stock is back in PostgreSQL, so a lingering hold would under-sell until
 * its TTL.
 */
export async function releaseLingeringHold(
  locks: InventoryLockService,
  order: Order,
): Promise<void> {
  if (order.reservation_id !== null) {
    await locks.release(order.vendor_id, order.reservation_id);
  }
}
