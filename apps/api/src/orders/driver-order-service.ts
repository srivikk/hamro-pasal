import {
  orderAddresses,
  orderItems,
  orders,
  vendors,
  type Database,
  type Transaction,
} from '@hamro-pasal/db';
import type { FulfillmentMode, Order, OrderAddress, OrderItem } from '@hamro-pasal/shared-types';
import { and, asc, eq, inArray, isNull, or } from 'drizzle-orm';

import { OrderNotFoundError } from '../checkout/checkout-service';
import type { DeliveryHandoff, DeliveryResult } from './delivery-handoff';

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

/**
 * The platform rider's side of an order (delivery partner flow, steps 3–5). A rider may see and
 * deliver a fleet order that is theirs or not yet claimed by any rider (nothing assigns gigs yet);
 * delivering records them as its driver. Anyone else's order is ORDER_NOT_FOUND.
 */
export class DriverOrderService {
  constructor(
    private readonly db: Database,
    private readonly handoff: DeliveryHandoff,
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
   * POST /api/driver/orders/:id/deliver (customer journey 10, driver flow step 5): the shared
   * handoff (`DeliveryHandoff`) under the order row lock; this rider is recorded as the driver.
   * The rider who delivered an order gets the same success again on a retry.
   */
  async deliver(driverUserId: string, orderId: string, otp: string): Promise<DeliveryResult> {
    const result = await this.db.transaction(async (tx) => {
      const order = await this.lockCarriableOrder(tx, driverUserId, orderId);
      if (order.state === 'DELIVERED' && order.driver_user_id === driverUserId) {
        return { order, replayed: true };
      }
      return { order: await this.handoff.handOver(tx, order, otp, driverUserId), replayed: false };
    });
    await this.handoff.afterCommit(result);
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
