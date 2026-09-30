import {
  enqueueDomainEvent,
  orderAddresses,
  orderItems,
  orders,
  products,
  reviews,
  vendors,
  type Database,
} from '@hamro-pasal/db';
import {
  COD_MIN_CUSTOMER_RATING,
  type CheckoutRequest,
  type DomainEvent,
  type Order,
} from '@hamro-pasal/shared-types';
import { and, avg, count, eq, gte, inArray, sql } from 'drizzle-orm';

import { isUniqueViolation } from '../infra/pg-errors';
import type { RedisKeyedMutex } from '../infra/redis-mutex';
import {
  InsufficientStockError,
  ProductUnavailableError,
  ReservationExpiredError,
} from '../inventory/errors';
import { toNpr } from '../ledger/money';
import { reviewIsPublic } from '../reviews/review-visibility';
import { enqueueOrderStateChanged } from '../orders/order-events';
import { generateDeliveryOtp, hashDeliveryOtp } from './delivery-otp';
import { CheckoutRejectedError, priceCart } from './pricing';
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

export class OrderNotFoundError extends Error {
  constructor(readonly orderId: string) {
    super(`Order ${orderId} not found`);
    this.name = 'OrderNotFoundError';
  }
}

export interface CheckoutResult {
  readonly order: Order;
  readonly reservation: { readonly id: string | null; readonly expiresAt: Date | null };
  /**
   * The raw 4-digit handoff code. Returned once; only its bcrypt hash is stored. A replayed
   * checkout rotates it, so the latest response always holds a valid code.
   */
  readonly deliveryOtp: string | null;
  readonly replayed: boolean;
}

export type LockStatusView =
  | { readonly status: 'ACTIVE'; readonly ttlMs: number; readonly expiresAt: Date }
  /** TTL hit 0 before payment: SPEC edge case 1, the client purges the cart. */
  | { readonly status: 'EXPIRED' }
  /** The lock was claimed (order placed) or the order left checkout. */
  | { readonly status: 'RELEASED' };

/** Order states in which the customer still needs the handoff OTP. */
const OTP_ROTATABLE_STATES = new Set<Order['state']>([
  'PENDING_PAYMENT',
  'PLACED',
  'PREPARING',
  'OUT_FOR_DELIVERY',
]);

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
    private readonly mutex: RedisKeyedMutex,
  ) {}

  /**
   * POST /api/cart/checkout: locks the cart's quantities for 600 s (SPEC §3) and creates the
   * PENDING_PAYMENT order, priced on the server, in one step. COD orders are confirmed at once
   * (lock claimed, order PLACED). Prepaid orders wait for the gateway to confirm within the lock.
   * Replaying the same idempotency key returns the same order.
   */
  checkout(customerId: string, request: CheckoutRequest): Promise<CheckoutResult> {
    // Same-key submissions are serialised: a retry that races the original must get the original
    // order back. Otherwise it would find the stock already held and report it as unavailable.
    return this.mutex.runExclusive(`checkout:${request.idempotency_key}`, () =>
      this.checkoutExclusive(customerId, request),
    );
  }

  private async checkoutExclusive(
    customerId: string,
    request: CheckoutRequest,
  ): Promise<CheckoutResult> {
    const existing = await this.findByIdempotencyKey(request.idempotency_key);
    if (existing !== undefined) {
      return this.replay(customerId, existing);
    }

    const [vendor] = await this.db.select().from(vendors).where(eq(vendors.id, request.vendor_id));
    if (vendor?.status !== 'LIVE') {
      throw new CheckoutRejectedError('VENDOR_UNAVAILABLE', 'This vendor is not accepting orders');
    }

    const items = mergeLines(request.items);
    const catalogue = await this.db
      .select({ id: products.id, name: products.name, price_npr: products.price_npr })
      .from(products)
      .where(
        and(
          eq(products.vendor_id, vendor.id),
          eq(products.is_active, true),
          inArray(
            products.id,
            items.map((i) => i.productId),
          ),
        ),
      );
    const byId = new Map(catalogue.map((p) => [p.id, p]));
    const missing = items.filter((i) => !byId.has(i.productId)).map((i) => i.productId);
    if (missing.length > 0) {
      throw new ProductUnavailableError(missing);
    }
    const priced = priceCart(vendor, byId, items);

    if (request.payment_method === 'COD') {
      await this.assertCodEligible(customerId);
    }

    const otp = generateDeliveryOtp();
    const otpHash = await hashDeliveryOtp(otp);
    const reservation = await this.locks.reserve({ vendorId: vendor.id, customerId, items });

    let order: Order;
    try {
      order = await this.db.transaction(async (tx) => {
        const [created] = await tx
          .insert(orders)
          .values({
            idempotency_key: request.idempotency_key,
            customer_id: customerId,
            vendor_id: vendor.id,
            reservation_id: reservation.id,
            subtotal: toNpr(priced.subtotalPaisa),
            delivery_fee: toNpr(priced.deliveryFeePaisa),
            platform_commission_amount: toNpr(priced.commissionPaisa),
            fulfillment_locked: vendor.fulfillment_mode,
            payment_method: request.payment_method,
            delivery_otp: otpHash,
          })
          .returning();
        if (created === undefined) {
          throw new Error('Order insert returned no row');
        }
        await enqueueOrderStateChanged(tx, null, created);
        await tx.insert(orderItems).values(
          priced.lines.map((line) => ({
            order_id: created.id,
            product_id: line.productId,
            product_name: line.productName,
            unit_price_npr: toNpr(line.unitPricePaisa),
            quantity: line.quantity,
          })),
        );
        // Already validated and normalised (canonical district) by nepalAddressInputSchema.
        await tx
          .insert(orderAddresses)
          .values({ order_id: created.id, ...request.delivery_address });
        await enqueueDomainEvent(tx, {
          type: 'order.locked',
          aggregateId: reservation.id,
          occurredAt: reservation.lockedAt,
          payload: {
            reservation_id: reservation.id,
            vendor_id: vendor.id,
            customer_id: customerId,
            items: items.map((l) => ({ product_id: l.productId, quantity: l.quantity })),
            locked_at: reservation.lockedAt.toISOString(),
            expires_at: reservation.expiresAt.toISOString(),
          },
        });
        return created;
      });
    } catch (error: unknown) {
      // Redis and PostgreSQL cannot commit together: never leave an orphaned lock behind.
      await this.locks.release(vendor.id, reservation.id);
      if (isUniqueViolation(error, 'orders_idempotency_key_key')) {
        const winner = await this.findByIdempotencyKey(request.idempotency_key);
        if (winner !== undefined) return this.replay(customerId, winner);
      }
      throw error;
    }

    if (order.payment_method === 'COD') {
      const placed = await this.claim({
        orderId: order.id,
        vendorId: vendor.id,
        reservationId: reservation.id,
      });
      order = placed.order;
    }
    return {
      order,
      reservation: { id: reservation.id, expiresAt: reservation.expiresAt },
      deliveryOtp: otp,
      replayed: false,
    };
  }

  /** GET /api/cart/lock-status: the customer's view of an order's 600 s lock. */
  async getOrderLockStatus(
    customerId: string,
    orderId: string,
  ): Promise<{ order: Order; lock: LockStatusView }> {
    const [order] = await this.db
      .select()
      .from(orders)
      .where(and(eq(orders.id, orderId), eq(orders.customer_id, customerId)));
    if (order === undefined) {
      throw new OrderNotFoundError(orderId);
    }
    if (order.state !== 'PENDING_PAYMENT' || order.reservation_id === null) {
      return { order, lock: { status: 'RELEASED' } };
    }
    const status = await this.locks.getStatus(order.vendor_id, order.reservation_id);
    return {
      order,
      lock:
        status === null
          ? { status: 'EXPIRED' }
          : { status: 'ACTIVE', ttlMs: status.ttlMs, expiresAt: status.reservation.expiresAt },
    };
  }

  private async findByIdempotencyKey(key: string): Promise<Order | undefined> {
    const [order] = await this.db.select().from(orders).where(eq(orders.idempotency_key, key));
    return order;
  }

  private async replay(customerId: string, order: Order): Promise<CheckoutResult> {
    if (order.customer_id !== customerId) {
      throw new CheckoutRejectedError(
        'IDEMPOTENCY_KEY_REUSED',
        'This idempotency key belongs to another checkout',
        undefined,
        409,
      );
    }
    let deliveryOtp: string | null = null;
    if (OTP_ROTATABLE_STATES.has(order.state)) {
      deliveryOtp = generateDeliveryOtp();
      await this.db
        .update(orders)
        .set({ delivery_otp: await hashDeliveryOtp(deliveryOtp) })
        .where(eq(orders.id, order.id));
    }
    const status =
      order.reservation_id === null
        ? null
        : await this.locks.getStatus(order.vendor_id, order.reservation_id);
    return {
      order,
      reservation: {
        id: order.reservation_id,
        expiresAt: status?.reservation.expiresAt ?? null,
      },
      deliveryOtp,
      replayed: true,
    };
  }

  /**
   * SPEC §6 / journey 7: an average rating below 3.0 disables COD for the customer. Only public
   * vendor ratings count: a quarantined one (the double blind) does not, until it is published.
   */
  private async assertCodEligible(customerId: string): Promise<void> {
    const [rating] = await this.db
      .select({ average: avg(reviews.rating), total: count() })
      .from(reviews)
      .innerJoin(orders, eq(orders.id, reviews.order_id))
      .where(
        and(
          eq(orders.customer_id, customerId),
          eq(reviews.direction, 'VENDOR_TO_CUSTOMER'),
          reviewIsPublic(),
        ),
      );
    if (
      rating !== undefined &&
      rating.total > 0 &&
      Number(rating.average) < COD_MIN_CUSTOMER_RATING
    ) {
      throw new CheckoutRejectedError(
        'COD_NOT_AVAILABLE',
        'Cash on delivery is not available for this account',
      );
    }
  }

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
        .set({ state: 'PLACED', placed_at: sql`now()` })
        .where(eq(orders.id, order.id))
        .returning();
      if (updated === undefined) {
        throw new OrderNotPlaceableError(order.id, 'disappeared during placement');
      }
      await enqueueOrderStateChanged(tx, order.state, updated);

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

function mergeLines(items: CheckoutRequest['items']): { productId: string; quantity: number }[] {
  const merged = new Map<string, number>();
  for (const item of items) {
    merged.set(item.product_id, (merged.get(item.product_id) ?? 0) + item.quantity);
  }
  return [...merged].map(([productId, quantity]) => ({ productId, quantity }));
}
