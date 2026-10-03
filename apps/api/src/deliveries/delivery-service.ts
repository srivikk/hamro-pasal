import {
  deliveries,
  orderAddresses,
  orderItems,
  orders,
  vendors,
  type Database,
  type Transaction,
} from '@hamro-pasal/db';
import type {
  DeliveryState,
  FulfillmentMode,
  Order,
  OrderAddress,
  OrderItem,
} from '@hamro-pasal/shared-types';
import { and, asc, eq, inArray, isNotNull, or, sql } from 'drizzle-orm';

import type { DeliveryHandoff, DeliveryResult } from '../orders/delivery-handoff';

export type Delivery = typeof deliveries.$inferSelect;

/** Orders a platform rider carries. SELF_DELIVERY orders are handed over by the vendor's staff. */
export const FLEET_FULFILLMENT_MODES = [
  'PLATFORM_FLEET',
  'EMERGENCY_FLEET',
] as const satisfies FulfillmentMode[];

/** A safety cap on the rider's list. */
export const RIDER_DELIVERIES_LIMIT = 100;

/** Deliveries a rider is on the road for: the ones whose position customers follow. */
const ON_THE_ROAD = ['ASSIGNED', 'PICKED_UP'] as const satisfies DeliveryState[];

/** Unknown id, or a delivery that belongs to another rider (ids cannot be probed). */
export class DeliveryNotFoundError extends Error {
  constructor(readonly deliveryId: string) {
    super(`Delivery ${deliveryId} not found`);
    this.name = 'DeliveryNotFoundError';
  }
}

/** The gig was open when the rider saw it, and another rider accepted it first. */
export class DeliveryAlreadyAssignedError extends Error {
  constructor(readonly deliveryId: string) {
    super(`Delivery ${deliveryId} was accepted by another rider`);
    this.name = 'DeliveryAlreadyAssignedError';
  }
}

export type DeliveryStep = 'accept' | 'pickup' | 'complete';

/** The delivery is not in the state this step starts from. */
export class DeliveryStateConflictError extends Error {
  constructor(
    readonly deliveryId: string,
    readonly step: DeliveryStep,
    readonly state: DeliveryState,
  ) {
    super(`Delivery ${deliveryId} cannot ${step} in state ${state}`);
    this.name = 'DeliveryStateConflictError';
  }
}

export interface RiderDelivery {
  readonly delivery: Delivery;
  readonly order: Order;
  readonly vendorBusinessName: string;
  readonly items: readonly OrderItem[];
  readonly address: OrderAddress | null;
}

export interface DeliveryStepResult {
  readonly delivery: RiderDelivery;
  /** true when this rider had already taken the step (a retried request). */
  readonly replayed: boolean;
}

/**
 * Opens the gig for a fleet order in the dispatching transaction (vendor flow step 8). Idempotent
 * per order; a SELF_DELIVERY order gets no delivery (the shop's own staff carry it).
 */
export async function offerDelivery(tx: Transaction, order: Order): Promise<void> {
  if (!isFleetOrder(order)) return;
  await tx.insert(deliveries).values({ order_id: order.id }).onConflictDoNothing();
}

function isFleetOrder(order: Order): boolean {
  return (FLEET_FULFILLMENT_MODES as readonly FulfillmentMode[]).includes(order.fulfillment_locked);
}

/**
 * The platform rider's side of a fleet order (delivery partner flow): accept an open gig, pick the
 * parcel up, hand it over with the customer's code. A fleet order can only be delivered through
 * its delivery, by the rider who accepted it; every step locks the order row and then the delivery
 * row, the order the shared handoff needs.
 */
export class DeliveryService {
  constructor(
    private readonly db: Database,
    private readonly handoff: DeliveryHandoff,
  ) {}

  /** GET /api/deliveries: open gigs and this rider's own deliveries, oldest dispatch first. */
  async list(riderId: string): Promise<RiderDelivery[]> {
    const rows = await this.db
      .select({ delivery: deliveries, order: orders, vendorBusinessName: vendors.business_name })
      .from(deliveries)
      .innerJoin(orders, eq(orders.id, deliveries.order_id))
      .innerJoin(vendors, eq(vendors.id, orders.vendor_id))
      .where(
        and(
          eq(orders.state, 'OUT_FOR_DELIVERY'),
          or(
            eq(deliveries.state, 'OFFERED'),
            and(eq(deliveries.rider_id, riderId), inArray(deliveries.state, ON_THE_ROAD)),
          ),
        ),
      )
      .orderBy(asc(deliveries.created_at), asc(deliveries.id))
      .limit(RIDER_DELIVERIES_LIMIT);
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
    return rows.map((row) => ({
      ...row,
      items: items.filter((item) => item.order_id === row.order.id),
      address: addresses.find((address) => address.order_id === row.order.id) ?? null,
    }));
  }

  /**
   * POST /api/deliveries/:id/accept (driver flow step 1): OFFERED → ASSIGNED for the caller, who
   * is also recorded on the order (`orders.driver_user_id`). The row lock lets exactly one of
   * several riders win; the others get 409. Accepting one's own delivery again is the same success.
   */
  accept(riderId: string, deliveryId: string): Promise<DeliveryStepResult> {
    return this.db.transaction(async (tx) => {
      const { delivery, order } = await this.lock(tx, deliveryId);
      if (delivery.rider_id === riderId && isOnTheRoad(delivery.state)) {
        return { delivery: await this.detail(tx, delivery, order), replayed: true };
      }
      if (delivery.rider_id !== null && delivery.rider_id !== riderId) {
        throw new DeliveryAlreadyAssignedError(deliveryId);
      }
      if (delivery.state !== 'OFFERED' || order.state !== 'OUT_FOR_DELIVERY') {
        throw new DeliveryStateConflictError(deliveryId, 'accept', delivery.state);
      }

      const [assigned] = await tx
        .update(deliveries)
        .set({ state: 'ASSIGNED', rider_id: riderId, accepted_at: sql`now()` })
        .where(eq(deliveries.id, deliveryId))
        .returning();
      const [claimed] = await tx
        .update(orders)
        .set({ driver_user_id: riderId })
        .where(eq(orders.id, order.id))
        .returning();
      if (assigned === undefined || claimed === undefined) {
        throw new Error(`Delivery ${deliveryId} disappeared during accept`);
      }
      return { delivery: await this.detail(tx, assigned, claimed), replayed: false };
    });
  }

  /**
   * POST /api/deliveries/:id/pickup (driver flow step 2, "Picked Up"): ASSIGNED → PICKED_UP by the
   * rider who accepted it. Repeating it is the same success.
   */
  pickUp(riderId: string, deliveryId: string): Promise<DeliveryStepResult> {
    return this.db.transaction(async (tx) => {
      const { delivery, order } = await this.lockOwn(tx, riderId, deliveryId);
      if (delivery.state === 'PICKED_UP') {
        return { delivery: await this.detail(tx, delivery, order), replayed: true };
      }
      if (delivery.state !== 'ASSIGNED' || order.state !== 'OUT_FOR_DELIVERY') {
        throw new DeliveryStateConflictError(deliveryId, 'pickup', delivery.state);
      }
      const [pickedUp] = await tx
        .update(deliveries)
        .set({ state: 'PICKED_UP', picked_up_at: sql`now()` })
        .where(eq(deliveries.id, deliveryId))
        .returning();
      if (pickedUp === undefined) throw new Error(`Delivery ${deliveryId} disappeared at pickup`);
      return { delivery: await this.detail(tx, pickedUp, order), replayed: false };
    });
  }

  /**
   * POST /api/deliveries/:id/complete (customer journey 10, driver flow step 5): the customer's
   * 4-digit code at the door. Only a PICKED_UP delivery reaches the code check (an earlier state
   * is 409 and counts no attempt); then the shared handoff (`DeliveryHandoff`: lockout, bcrypt
   * check, order DELIVERED + hash erased + escrow settled) and the delivery's own DELIVERED, in
   * one commit. The rider who completed it gets the same success again on a retry.
   */
  async complete(riderId: string, deliveryId: string, otp: string): Promise<DeliveryResult> {
    const result = await this.db.transaction(async (tx) => {
      const { delivery, order } = await this.lockOwn(tx, riderId, deliveryId);
      if (delivery.state === 'DELIVERED') return { order, replayed: true };
      if (delivery.state !== 'PICKED_UP') {
        throw new DeliveryStateConflictError(deliveryId, 'complete', delivery.state);
      }
      const delivered = await this.handoff.handOver(tx, order, otp, riderId);
      await tx
        .update(deliveries)
        .set({ state: 'DELIVERED', completed_at: sql`now()` })
        .where(eq(deliveries.id, deliveryId));
      return { order: delivered, replayed: false };
    });
    await this.handoff.afterCommit(result);
    return result;
  }

  /**
   * The riders on the road for these orders (accepted or picked up, order still out for
   * delivery): whose position the customers subscribed to those orders are shown.
   */
  async ridersOnTheRoad(orderIds: readonly string[]): Promise<Map<string, string>> {
    if (orderIds.length === 0) return new Map();
    const rows = await this.db
      .select({ orderId: deliveries.order_id, riderId: deliveries.rider_id })
      .from(deliveries)
      .innerJoin(orders, eq(orders.id, deliveries.order_id))
      .where(
        and(
          inArray(deliveries.order_id, [...orderIds]),
          inArray(deliveries.state, ON_THE_ROAD),
          isNotNull(deliveries.rider_id),
          eq(orders.state, 'OUT_FOR_DELIVERY'),
        ),
      );
    const riders = new Map<string, string>();
    for (const row of rows) {
      if (row.riderId !== null) riders.set(row.orderId, row.riderId);
    }
    return riders;
  }

  /** The order row, then the delivery row, both locked `FOR UPDATE`; unknown id → 404. */
  private async lock(
    tx: Transaction,
    deliveryId: string,
  ): Promise<{ delivery: Delivery; order: Order }> {
    const [found] = await tx
      .select({ orderId: deliveries.order_id })
      .from(deliveries)
      .where(eq(deliveries.id, deliveryId));
    if (found === undefined) throw new DeliveryNotFoundError(deliveryId);
    // Order first: dispatch and the handoff hold the order lock when they touch the delivery.
    const [order] = await tx
      .select()
      .from(orders)
      .where(eq(orders.id, found.orderId))
      .for('update');
    const [delivery] = await tx
      .select()
      .from(deliveries)
      .where(eq(deliveries.id, deliveryId))
      .for('update');
    if (order === undefined || delivery === undefined) throw new DeliveryNotFoundError(deliveryId);
    return { delivery, order };
  }

  /** As `lock`, for a step only the delivery's own rider may take; anyone else gets 404. */
  private async lockOwn(
    tx: Transaction,
    riderId: string,
    deliveryId: string,
  ): Promise<{ delivery: Delivery; order: Order }> {
    const locked = await this.lock(tx, deliveryId);
    if (locked.delivery.rider_id !== riderId) throw new DeliveryNotFoundError(deliveryId);
    return locked;
  }

  private async detail(tx: Transaction, delivery: Delivery, order: Order): Promise<RiderDelivery> {
    const [vendor] = await tx
      .select({ businessName: vendors.business_name })
      .from(vendors)
      .where(eq(vendors.id, order.vendor_id));
    if (vendor === undefined) throw new Error(`Order ${order.id} has no vendor`);
    const items = await tx
      .select()
      .from(orderItems)
      .where(eq(orderItems.order_id, order.id))
      .orderBy(asc(orderItems.created_at), asc(orderItems.id));
    const [address] = await tx
      .select()
      .from(orderAddresses)
      .where(eq(orderAddresses.order_id, order.id));
    return {
      delivery,
      order,
      vendorBusinessName: vendor.businessName,
      items,
      address: address ?? null,
    };
  }
}

function isOnTheRoad(state: DeliveryState): boolean {
  return (ON_THE_ROAD as readonly DeliveryState[]).includes(state);
}
