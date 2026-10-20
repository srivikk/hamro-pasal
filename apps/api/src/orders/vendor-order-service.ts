import {
  orderAddresses,
  orderItems,
  orders,
  vendors,
  type Database,
  type Transaction,
} from '@hamro-pasal/db';
import {
  ORDER_CANCELLATION_WINDOW_SECONDS,
  type FulfillmentMode,
  type Order,
  type OrderAddress,
  type OrderItem,
  type OrderState,
} from '@hamro-pasal/shared-types';
import { recordMissedOrder, resetMissedOrders } from '@hamro-pasal/ledger';
import { and, asc, eq, inArray, or, sql } from 'drizzle-orm';

import { OrderNotFoundError } from '../checkout/checkout-service';
import { offerDelivery } from '../deliveries/delivery-service';
import type { InventoryLockService } from '../inventory/inventory-lock-service';
import type { DeliveryHandoff, DeliveryResult } from './delivery-handoff';
import { enqueueOrderStateChanged } from './order-events';
import { cancelPlacedOrder, releaseLingeringHold } from './order-service';

/** A VENDOR account that has no shop (vendors row) yet. */
export class VendorAccountNotFoundError extends Error {
  constructor(readonly userId: string) {
    super(`No vendor belongs to user ${userId}`);
    this.name = 'VendorAccountNotFoundError';
  }
}

export type VendorDecision = 'accept' | 'reject' | 'dispatch';

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

/**
 * SPEC core 10 (amended 2026-10-20): a shop without a verified PAN does not trade. It cannot take
 * on a new order, even one placed just before its PAN changed; orders it had already accepted are
 * completed.
 */
export class VendorComplianceSuspendedError extends Error {
  constructor(readonly orderId: string) {
    super(`Order ${orderId} cannot be accepted: the shop is offline until its PAN is verified`);
    this.name = 'VendorComplianceSuspendedError';
  }
}

/**
 * Dispatch was asked while the customer's 60 s cancellation window is still open. Once out for
 * delivery an order can no longer be canceled, so dispatching early would cut the window short.
 */
export class CancellationWindowOpenError extends Error {
  constructor(
    readonly orderId: string,
    readonly retryAfterSeconds: number,
  ) {
    super(
      `Order ${orderId} cannot be dispatched during the customer's ${String(ORDER_CANCELLATION_WINDOW_SECONDS)} s cancellation window`,
    );
    this.name = 'CancellationWindowOpenError';
  }
}

/**
 * The vendor asked to hand over an order its own staff do not carry: a PLATFORM_FLEET /
 * EMERGENCY_FLEET order is delivered (and its code checked) by the platform rider.
 */
export class WrongFulfillmentModeError extends Error {
  constructor(
    readonly orderId: string,
    readonly fulfillment: FulfillmentMode,
  ) {
    super(
      `Order ${orderId} is ${fulfillment}; only SELF_DELIVERY orders are handed over by the vendor`,
    );
    this.name = 'WrongFulfillmentModeError';
  }
}

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
    private readonly handoff: DeliveryHandoff,
  ) {}

  /** The vendor the user runs, or null (the `vendor:subscribe` socket rule). */
  async vendorIdForUser(userId: string): Promise<string | null> {
    const [row] = await this.db
      .select({ id: vendors.id })
      .from(vendors)
      .where(eq(vendors.user_id, userId));
    return row?.id ?? null;
  }

  /**
   * GET /api/vendors/orders: open orders (PLACED, then PREPARING, then the shop's own deliveries
   * OUT_FOR_DELIVERY), oldest placement first within each. A SELF_DELIVERY order on the road stays
   * listed because its customer code is checked on the vendor's device; a fleet order out for
   * delivery is the rider's and leaves the list.
   */
  async listOpen(vendorUserId: string): Promise<VendorOrder[]> {
    const vendorId = await this.vendorIdForUser(vendorUserId);
    if (vendorId === null) throw new VendorAccountNotFoundError(vendorUserId);

    const open = await this.db
      .select()
      .from(orders)
      .where(
        and(
          eq(orders.vendor_id, vendorId),
          or(
            inArray(orders.state, ['PLACED', 'PREPARING']),
            and(
              eq(orders.state, 'OUT_FOR_DELIVERY'),
              eq(orders.fulfillment_locked, 'SELF_DELIVERY'),
            ),
          ),
        ),
      )
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

    // New orders first: they are the ones ringing. The sort is stable, so placement order stays.
    const ranked = [...open].sort((a, b) => dashboardRank(a) - dashboardRank(b));
    return ranked.map((order) => ({
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
   *
   * A shop suspended for compliance (no verified PAN, SPEC core 10) is refused (409). Its status is
   * read FOR SHARE after the order row, the order a delivery locks them in: a PAN change taking
   * the shop offline (vendor row FOR UPDATE) either commits first and is seen here, or waits for
   * this accept to commit.
   */
  accept(vendorUserId: string, orderId: string): Promise<VendorDecisionResult> {
    return this.db.transaction(async (tx) => {
      const order = await this.lockVendorOrder(tx, vendorUserId, orderId);
      if (order.state === 'PREPARING') return { order, replayed: true };
      if (order.state !== 'PLACED')
        throw new OrderDecisionConflictError(orderId, 'accept', order.state);
      const [shop] = await tx
        .select({ status: vendors.status })
        .from(vendors)
        .where(eq(vendors.id, order.vendor_id))
        .for('share');
      if (shop?.status === 'SUSPENDED_COMPLIANCE')
        throw new VendorComplianceSuspendedError(orderId);

      const [accepted] = await tx
        .update(orders)
        .set({ state: 'PREPARING' })
        .where(eq(orders.id, orderId))
        .returning();
      if (accepted === undefined) throw new Error(`Order ${orderId} disappeared during accept`);
      await enqueueOrderStateChanged(tx, order.state, accepted);
      // Step 7.3: an accepted order ends a run of missed ones (Auto-Pause counts in a row).
      await resetMissedOrders(tx, order.vendor_id);
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
      const canceled = await cancelPlacedOrder(tx, order);
      // Step 7.3: a rejection counts as missed; the third in a row pauses the shop.
      await recordMissedOrder(tx, order.vendor_id, {
        kind: 'USER',
        user_id: vendorUserId,
        role: 'VENDOR',
      });
      return { order: canceled, replayed: false };
    });
    if (!result.replayed) await releaseLingeringHold(this.locks, result.order);
    return result;
  }

  /**
   * POST /api/vendors/orders/:id/dispatch (vendor flow step 8): PREPARING → OUT_FOR_DELIVERY, with
   * `order.state_changed` in the same commit. Refused (422) until `placed_at + 60 s` on the
   * database clock: the customer's unskippable cancellation window is never shortened by the
   * vendor. Dispatching an order already out for delivery answers the same success.
   */
  dispatch(vendorUserId: string, orderId: string): Promise<VendorDecisionResult> {
    return this.db.transaction(async (tx) => {
      const order = await this.lockVendorOrder(tx, vendorUserId, orderId);
      if (order.state === 'OUT_FOR_DELIVERY') return { order, replayed: true };
      if (order.state !== 'PREPARING')
        throw new OrderDecisionConflictError(orderId, 'dispatch', order.state);

      // Same clock and boundary as the customer's cancel (open while elapsed <= 60 s), read after
      // the row lock is held, so a cancel and a dispatch can never both succeed.
      const [window] = await tx
        .select({
          remaining:
            sql<number>`ceil(extract(epoch from ${orders.placed_at} + make_interval(secs => ${ORDER_CANCELLATION_WINDOW_SECONDS}) - clock_timestamp()))`.mapWith(
              Number,
            ),
          open: sql<boolean>`clock_timestamp() - ${orders.placed_at} <= make_interval(secs => ${ORDER_CANCELLATION_WINDOW_SECONDS})`.mapWith(
            Boolean,
          ),
        })
        .from(orders)
        .where(eq(orders.id, orderId));
      if (window?.open !== false) {
        throw new CancellationWindowOpenError(orderId, Math.max(1, window?.remaining ?? 1));
      }

      const [dispatched] = await tx
        .update(orders)
        .set({ state: 'OUT_FOR_DELIVERY' })
        .where(eq(orders.id, orderId))
        .returning();
      if (dispatched === undefined) throw new Error(`Order ${orderId} disappeared during dispatch`);
      // A fleet order becomes an open gig for the platform riders in the same commit.
      await offerDelivery(tx, dispatched);
      await enqueueOrderStateChanged(tx, order.state, dispatched);
      return { order: dispatched, replayed: false };
    });
  }

  /**
   * POST /api/vendors/orders/:id/deliver (vendor flow step 9): the shop's own staff hand over a
   * SELF_DELIVERY order with the customer's code. Exactly the rider's handoff (`DeliveryHandoff`:
   * bcrypt check, 5-try Redis lockout, DELIVERED + hash erased + escrow settled in one commit), with
   * no rider recorded. A fleet order is refused with 409 before any code is checked (it is the
   * platform rider's to deliver). Repeating a successful delivery answers the same success.
   */
  async deliver(vendorUserId: string, orderId: string, otp: string): Promise<DeliveryResult> {
    const result = await this.db.transaction(async (tx) => {
      const order = await this.lockVendorOrder(tx, vendorUserId, orderId);
      if (order.fulfillment_locked !== 'SELF_DELIVERY') {
        throw new WrongFulfillmentModeError(orderId, order.fulfillment_locked);
      }
      if (order.state === 'DELIVERED') return { order, replayed: true };
      return { order: await this.handoff.handOver(tx, order, otp, null), replayed: false };
    });
    await this.handoff.afterCommit(result);
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

/** Dashboard order: new (ringing) first, then being packed, then on the road. */
function dashboardRank(order: Order): number {
  switch (order.state) {
    case 'PLACED':
      return 0;
    case 'PREPARING':
      return 1;
    default:
      return 2;
  }
}
