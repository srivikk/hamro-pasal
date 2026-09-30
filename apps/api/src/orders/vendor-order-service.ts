import {
  orderAddresses,
  orderItems,
  orders,
  vendors,
  type Database,
  type Transaction,
} from '@hamro-pasal/db';
import type { Order, OrderAddress, OrderItem, OrderState } from '@hamro-pasal/shared-types';
import { and, asc, eq, inArray } from 'drizzle-orm';

import { OrderNotFoundError } from '../checkout/checkout-service';
import type { InventoryLockService } from '../inventory/inventory-lock-service';
import { enqueueOrderStateChanged } from './order-events';
import { cancelPlacedOrder, releaseLingeringHold } from './order-service';

/** A VENDOR account that has no shop (vendors row) yet. */
export class VendorAccountNotFoundError extends Error {
  constructor(readonly userId: string) {
    super(`No vendor belongs to user ${userId}`);
    this.name = 'VendorAccountNotFoundError';
  }
}

export type VendorDecision = 'accept' | 'reject';

/** The order is not waiting for the vendor (already accepted, canceled, delivered, ...). */
export class OrderDecisionConflictError extends Error {
  constructor(
    readonly orderId: string,
    readonly decision: VendorDecision,
    readonly state: OrderState,
  ) {
    super(`Order ${orderId} cannot be ${decision}ed in state ${state}`);
    this.name = 'OrderDecisionConflictError';
  }
}

/** Orders the dashboard lists: waiting for a decision, and accepted ones being packed. */
export const VENDOR_OPEN_ORDER_STATES = ['PLACED', 'PREPARING'] as const satisfies OrderState[];

/** A safety cap on the dashboard list; a shop with more open orders than this has other problems. */
export const VENDOR_OPEN_ORDERS_LIMIT = 100;

export interface VendorOrder {
  readonly order: Order;
  readonly items: readonly OrderItem[];
  readonly address: OrderAddress | null;
}

export interface VendorDecisionResult {
  readonly order: Order;
  /** true when the same decision had already been applied by an earlier request. */
  readonly replayed: boolean;
}

/**
 * The vendor's side of an order (vendor flow steps 6–7). Every order is addressed through the
 * vendor that owns it (`vendors.user_id` = the caller); anyone else's order is ORDER_NOT_FOUND, so
 * ids cannot be probed.
 */
export class VendorOrderService {
  constructor(
    private readonly db: Database,
    private readonly locks: InventoryLockService,
  ) {}

  /** The vendor the user runs, or null (the `vendor:subscribe` socket rule). */
  async vendorIdForUser(userId: string): Promise<string | null> {
    const [row] = await this.db
      .select({ id: vendors.id })
      .from(vendors)
      .where(eq(vendors.user_id, userId));
    return row?.id ?? null;
  }

  /** GET /api/vendors/orders: open orders, PLACED before PREPARING, oldest placement first. */
  async listOpen(vendorUserId: string): Promise<VendorOrder[]> {
    const vendorId = await this.vendorIdForUser(vendorUserId);
    if (vendorId === null) throw new VendorAccountNotFoundError(vendorUserId);

    const open = await this.db
      .select()
      .from(orders)
      .where(and(eq(orders.vendor_id, vendorId), inArray(orders.state, VENDOR_OPEN_ORDER_STATES)))
      .orderBy(asc(orders.placed_at), asc(orders.id))
      .limit(VENDOR_OPEN_ORDERS_LIMIT);
    if (open.length === 0) return [];

    const ids = open.map((order) => order.id);
    const [items, addresses] = await Promise.all([
      this.db
        .select()
        .from(orderItems)
        .where(inArray(orderItems.order_id, ids))
        .orderBy(asc(orderItems.created_at), asc(orderItems.id)),
      this.db.select().from(orderAddresses).where(inArray(orderAddresses.order_id, ids)),
    ]);

    // New orders first: they are the ones ringing.
    const placedFirst = [
      ...open.filter((order) => order.state === 'PLACED'),
      ...open.filter((order) => order.state !== 'PLACED'),
    ];
    return placedFirst.map((order) => ({
      order,
      items: items.filter((item) => item.order_id === order.id),
      address: addresses.find((address) => address.order_id === order.id) ?? null,
    }));
  }

  /**
   * POST /api/vendors/orders/:id/accept: PLACED → PREPARING, with `order.state_changed` in the
   * same commit (the customer's tracker and the vendor's other devices hear it over /orders).
   * Accepting stops the 90 s escalation: its worker re-reads the state under the same row lock.
   * The customer's 60 s cancellation window is not shortened by an early accept.
   */
  accept(vendorUserId: string, orderId: string): Promise<VendorDecisionResult> {
    return this.db.transaction(async (tx) => {
      const order = await this.lockVendorOrder(tx, vendorUserId, orderId);
      if (order.state === 'PREPARING') return { order, replayed: true };
      if (order.state !== 'PLACED')
        throw new OrderDecisionConflictError(orderId, 'accept', order.state);

      const [accepted] = await tx
        .update(orders)
        .set({ state: 'PREPARING' })
        .where(eq(orders.id, orderId))
        .returning();
      if (accepted === undefined) throw new Error(`Order ${orderId} disappeared during accept`);
      await enqueueOrderStateChanged(tx, order.state, accepted);
      return { order: accepted, replayed: false };
    });
  }

  /**
   * POST /api/vendors/orders/:id/reject: PLACED → CANCELED with the customer cancellation's exact
   * effects (stock restored, `order.state_changed`, and for a PAID order `refund_required` plus
   * `order.canceled_refund_due` for the escrow refund), all in one commit. An order that is
   * already CANCELED (rejected before, or canceled by the customer) answers the same success.
   */
  async reject(vendorUserId: string, orderId: string): Promise<VendorDecisionResult> {
    const result = await this.db.transaction(async (tx) => {
      const order = await this.lockVendorOrder(tx, vendorUserId, orderId);
      if (order.state === 'CANCELED') return { order, replayed: true };
      if (order.state !== 'PLACED')
        throw new OrderDecisionConflictError(orderId, 'reject', order.state);
      return { order: await cancelPlacedOrder(tx, order), replayed: false };
    });
    if (!result.replayed) await releaseLingeringHold(this.locks, result.order);
    return result;
  }

  /** The order row, locked `FOR UPDATE`, if the user runs its vendor; otherwise 404. */
  private async lockVendorOrder(
    tx: Transaction,
    vendorUserId: string,
    orderId: string,
  ): Promise<Order> {
    const [row] = await tx
      .select({ order: orders })
      .from(orders)
      .innerJoin(vendors, eq(vendors.id, orders.vendor_id))
      .where(and(eq(orders.id, orderId), eq(vendors.user_id, vendorUserId)))
      .for('update', { of: orders });
    if (row === undefined) throw new OrderNotFoundError(orderId);
    return row.order;
  }
}
