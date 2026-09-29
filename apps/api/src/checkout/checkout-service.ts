import { enqueueDomainEvent, orders, products, type Database } from '@hamro-pasal/db';
import type { DomainEvent, Order } from '@hamro-pasal/shared-types';
import { and, eq, gte, sql } from 'drizzle-orm';

import { InsufficientStockError, ReservationExpiredError } from '../inventory/errors';
import type {
  InventoryLockService,
  InventoryReservation,
  LockRequest,
  ReservationStatus,
} from '../inventory/inventory-lock-service';

export class OrderNotPlaceableError extends Error {
  constructor(
    readonly orderId: string,
    reason: string,
  ) {
    super(`Order ${orderId} cannot be placed: ${reason}`);
    this.name = 'OrderNotPlaceableError';
  }
}

export interface PlaceOrderInput {
  readonly orderId: string;
  readonly vendorId: string;
  readonly reservationId: string;
}

export interface PlacedOrder {
  readonly order: Order;
  readonly event: DomainEvent;
}

/**
 * Checkout workflows around the SPEC §3 inventory lock:
 *   lock    - reserve cart quantities for 600 s, emit order.locked
 *   claim   - payment/COD confirmed: permanent PostgreSQL decrement + PLACED + order.placed,
 *             all in one DB transaction, then the Redis lock is deleted
 *   release - customer abandons checkout: lock deleted, quantities available immediately
 */
export class CheckoutService {
  constructor(
    private readonly db: Database,
    private readonly locks: InventoryLockService,
  ) {}

  async lockCart(request: LockRequest): Promise<InventoryReservation> {
    const reservation = await this.locks.reserve(request);
    try {
      await enqueueDomainEvent(this.db, {
        type: 'order.locked',
        aggregateId: reservation.id,
        occurredAt: reservation.lockedAt,
        payload: {
          reservation_id: reservation.id,
          vendor_id: reservation.vendorId,
          customer_id: reservation.customerId,
          items: reservation.items.map((l) => ({ product_id: l.productId, quantity: l.quantity })),
          locked_at: reservation.lockedAt.toISOString(),
          expires_at: reservation.expiresAt.toISOString(),
        },
      });
    } catch (error: unknown) {
      // Redis and PostgreSQL cannot commit atomically. Never leave a lock nobody was told about.
      await this.locks.release(reservation.vendorId, reservation.id);
      throw error;
    }
    return reservation;
  }

  getLockStatus(vendorId: string, reservationId: string): Promise<ReservationStatus | null> {
    return this.locks.getStatus(vendorId, reservationId);
  }

  releaseCart(vendorId: string, reservationId: string): Promise<boolean> {
    return this.locks.release(vendorId, reservationId);
  }

  /**
   * Claims a live reservation for an order whose payment is confirmed (prepaid: captured / PAID;
   * COD: accepted at checkout). The stock decrement is guarded by `stock_quantity >= qty`, so
   * PostgreSQL can never oversell even if a lock expired mid-claim.
   */
  async claim(input: PlaceOrderInput): Promise<PlacedOrder> {
    const status = await this.locks.getStatus(input.vendorId, input.reservationId);
    if (status === null) {
      throw new ReservationExpiredError(input.reservationId);
    }
    const { reservation } = status;

    const placed = await this.db.transaction(async (tx) => {
      const [order] = await tx
        .select()
        .from(orders)
        .where(eq(orders.id, input.orderId))
        .for('update');
      if (order === undefined) {
        throw new OrderNotPlaceableError(input.orderId, 'not found');
      }
      if (order.state !== 'PENDING_PAYMENT') {
        throw new OrderNotPlaceableError(order.id, `state is ${order.state}`);
      }
      if (
        order.vendor_id !== reservation.vendorId ||
        order.customer_id !== reservation.customerId
      ) {
        throw new OrderNotPlaceableError(order.id, 'reservation belongs to another cart');
      }
      if (order.payment_method !== 'COD' && order.payment_status !== 'PAID') {
        throw new OrderNotPlaceableError(order.id, `prepaid order is ${order.payment_status}`);
      }

      for (const line of reservation.items) {
        const decremented = await tx
          .update(products)
          .set({ stock_quantity: sql`${products.stock_quantity} - ${line.quantity}` })
          .where(
            and(
              eq(products.id, line.productId),
              eq(products.vendor_id, order.vendor_id),
              gte(products.stock_quantity, line.quantity),
            ),
          )
          .returning({ id: products.id });
        if (decremented.length === 0) {
          throw new InsufficientStockError([
            { productId: line.productId, requested: line.quantity, available: 0 },
          ]);
        }
      }

      const [updated] = await tx
        .update(orders)
        .set({ state: 'PLACED' })
        .where(eq(orders.id, order.id))
        .returning();
      if (updated === undefined) {
        throw new OrderNotPlaceableError(order.id, 'disappeared during placement');
      }

      const event = await enqueueDomainEvent(tx, {
        type: 'order.placed',
        aggregateId: updated.id,
        payload: {
          order_id: updated.id,
          reservation_id: reservation.id,
          vendor_id: updated.vendor_id,
          customer_id: updated.customer_id,
          payment_method: updated.payment_method,
          fulfillment_locked: updated.fulfillment_locked,
          subtotal: updated.subtotal,
          delivery_fee: updated.delivery_fee,
          items: reservation.items.map((l) => ({ product_id: l.productId, quantity: l.quantity })),
        },
      });
      return { order: updated, event };
    });

    // After commit: the quantities are now permanently deducted in PostgreSQL, so drop the holds.
    // If this fails the holds only expire later (conservative: under-, never over-allocation).
    await this.locks.release(input.vendorId, input.reservationId);
    return placed;
  }
}
