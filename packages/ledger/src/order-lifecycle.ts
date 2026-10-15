import {
  enqueueDomainEvent,
  orderItems,
  orders,
  platformSettings,
  products,
  recordAuditLog,
  vendors,
  type Executor,
  type Transaction,
} from '@hamro-pasal/db';
import type { AuditActor, DomainEvent, Order, OrderState } from '@hamro-pasal/shared-types';
import { and, asc, eq, gt, sql } from 'drizzle-orm';

import { toNpr } from './money';
import { orderTotalPaisa } from './settlement-plan';

/**
 * Writes `order.state_changed` to the outbox. Call it with the transaction that changed
 * `orders.state`, passing the row as returned by that UPDATE/INSERT, so the event commits if and
 * only if the change does. Every state mutation must go through here: the /orders Socket.io
 * namespace only learns of changes from these events. (Moved from the API in step 7.3 so the
 * worker's 5-minute auto-cancel writes exactly the same event.)
 */
export function enqueueOrderStateChanged(
  tx: Executor,
  fromState: OrderState | null,
  order: Order,
): Promise<DomainEvent> {
  return enqueueDomainEvent(tx, {
    type: 'order.state_changed',
    aggregateId: order.id,
    occurredAt: order.updated_at,
    payload: {
      order_id: order.id,
      customer_id: order.customer_id,
      vendor_id: order.vendor_id,
      from_state: fromState,
      to_state: order.state,
      payment_status: order.payment_status,
      refund_required: order.refund_required,
      placed_at: order.placed_at?.toISOString() ?? null,
      delivered_at: order.delivered_at?.toISOString() ?? null,
      changed_at: order.updated_at.toISOString(),
    },
  });
}

/**
 * Cancels a PLACED or PREPARING order whose row the caller holds FOR UPDATE: stock back, state
 * CANCELED, the refund flag and `order.canceled_refund_due` for a paid order. Shared by the
 * customer's cancel, the vendor's reject and the 5-minute auto-cancel (step 7.3).
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

export interface MissedOrderOutcome {
  readonly consecutiveMissed: number;
  /** This miss crossed the threshold: the shop is now auto-paused. */
  readonly paused: boolean;
}

/**
 * Auto-Pause (step 7.3, SPEC core 11): an order the vendor let expire or rejected counts as
 * missed. Called in the transaction that cancelled the order, after its row lock (the lock order
 * of a reject: order row, then vendor row). At `platform_settings.auto_pause_threshold` missed
 * orders in a row the shop is paused once: audited, and `vendor.auto_paused` tells the vendor.
 */
export async function recordMissedOrder(
  tx: Transaction,
  vendorId: string,
  actor: AuditActor,
): Promise<MissedOrderOutcome> {
  const [settings] = await tx
    .select({ threshold: platformSettings.auto_pause_threshold })
    .from(platformSettings);
  if (settings === undefined) throw new Error('platform_settings row is missing');

  const [vendor] = await tx
    .update(vendors)
    .set({ consecutive_missed_orders: sql`${vendors.consecutive_missed_orders} + 1` })
    .where(eq(vendors.id, vendorId))
    .returning();
  if (vendor === undefined) throw new Error(`Vendor ${vendorId} vanished`);
  if (vendor.consecutive_missed_orders < settings.threshold || vendor.auto_paused_at !== null) {
    return { consecutiveMissed: vendor.consecutive_missed_orders, paused: false };
  }

  const [paused] = await tx
    .update(vendors)
    .set({ auto_paused_at: sql`now()` })
    .where(eq(vendors.id, vendorId))
    .returning();
  if (paused?.auto_paused_at == null) throw new Error(`Vendor ${vendorId} vanished`);
  await recordAuditLog(tx, {
    actor,
    action: 'VENDOR_AUTO_PAUSED',
    entityId: vendorId,
    vendorId,
    beforeState: { auto_paused_at: null },
    afterState: {
      auto_paused_at: paused.auto_paused_at.toISOString(),
      consecutive_missed_orders: paused.consecutive_missed_orders,
    },
  });
  await enqueueDomainEvent(tx, {
    type: 'vendor.auto_paused',
    aggregateId: vendorId,
    occurredAt: paused.auto_paused_at,
    payload: {
      vendor_id: vendorId,
      vendor_phone: paused.phone,
      missed_orders: paused.consecutive_missed_orders,
      paused_at: paused.auto_paused_at.toISOString(),
    },
  });
  return { consecutiveMissed: paused.consecutive_missed_orders, paused: true };
}

/** An accepted order ends the run of missed ones. Writes nothing when the count is already 0. */
export async function resetMissedOrders(tx: Transaction, vendorId: string): Promise<void> {
  await tx
    .update(vendors)
    .set({ consecutive_missed_orders: 0 })
    .where(and(eq(vendors.id, vendorId), gt(vendors.consecutive_missed_orders, 0)));
}
