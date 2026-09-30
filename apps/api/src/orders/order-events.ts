import { enqueueDomainEvent, type Executor } from '@hamro-pasal/db';
import type { DomainEvent, Order, OrderState } from '@hamro-pasal/shared-types';

/**
 * Writes `order.state_changed` to the outbox. Call it with the transaction that changed
 * `orders.state`, passing the row as returned by that UPDATE/INSERT, so the event commits if and
 * only if the change does. Every state mutation must go through here: the /orders Socket.io
 * namespace only learns of changes from these events.
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
