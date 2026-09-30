import {
  enqueueDomainEvent,
  orderAddresses,
  orderItems,
  orders,
  products,
  type Database,
  type Transaction,
} from '@hamro-pasal/db';
import {
  ORDER_CANCELLATION_WINDOW_SECONDS,
  type Order,
  type OrderAddress,
  type OrderItem,
} from '@hamro-pasal/shared-types';
import { and, asc, eq, sql } from 'drizzle-orm';

import { OrderNotFoundError } from '../checkout/checkout-service';
import type { InventoryLockService } from '../inventory/inventory-lock-service';
import { toNpr } from '../ledger/money';
import { orderTotalPaisa } from '../payments/payment-confirmation';
import { enqueueOrderStateChanged } from './order-events';

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

/**
 * Cancels an order that was placed (its stock already permanently decremented), inside the
 * caller's transaction, which must hold the order row `FOR UPDATE`. Shared by the customer's
 * cancellation and the vendor's rejection, so both have identical effects:
 *   - the stock is added back per order line;
 *   - the state becomes CANCELED and `order.state_changed` is written to the outbox;
 *   - a PAID order is flagged `refund_required` and `order.canceled_refund_due` is written in
 *     the same commit (the escrow refund flow consumes it).
 */
export async function cancelPlacedOrder(tx: Transaction, order: Order): Promise<Order> {
  const lines = await tx
    .select({ productId: orderItems.product_id, quantity: orderItems.quantity })
    .from(orderItems)
    .where(eq(orderItems.order_id, order.id))
    .orderBy(asc(orderItems.product_id)); // stable lock order across concurrent restocks
  for (const line of lines) {
    await tx
      .update(products)
      .set({ stock_quantity: sql`${products.stock_quantity} + ${line.quantity}` })
      .where(and(eq(products.id, line.productId), eq(products.vendor_id, order.vendor_id)));
  }

  const refundRequired = order.payment_status === 'PAID';
  const [canceled] = await tx
    .update(orders)
    .set({ state: 'CANCELED', refund_required: refundRequired })
    .where(eq(orders.id, order.id))
    .returning();
  if (canceled === undefined) {
    throw new Error(`Order ${order.id} disappeared during cancellation`);
  }
  // Every cancellation, COD included, is announced (the refund event below is extra).
  await enqueueOrderStateChanged(tx, order.state, canceled);

  if (refundRequired) {
    if (canceled.payment_method === 'COD' || canceled.payment_gateway_ref === null) {
      throw new Error(`Order ${order.id} is PAID without a gateway payment`);
    }
    await enqueueDomainEvent(tx, {
      type: 'order.canceled_refund_due',
      aggregateId: canceled.id,
      payload: {
        order_id: canceled.id,
        vendor_id: canceled.vendor_id,
        customer_id: canceled.customer_id,
        payment_method: canceled.payment_method,
        payment_gateway_ref: canceled.payment_gateway_ref,
        refund_amount_npr: toNpr(orderTotalPaisa(canceled)),
        canceled_at: canceled.updated_at.toISOString(),
      },
    });
  }
  return canceled;
}

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
