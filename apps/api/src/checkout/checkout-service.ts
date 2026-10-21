import {
  campaignOptIns,
  enqueueDomainEvent,
  inVisibleCategory,
  ledgerAccounts,
  orderAddresses,
  orderItems,
  orders,
  platformCampaigns,
  platformSettings,
  products,
  reviews,
  vendorClosedReason,
  vendorOffers,
  vendors,
  type Database,
} from '@hamro-pasal/db';
import {
  COD_MIN_CUSTOMER_RATING,
  isGatewayPaymentMethod,
  paymentMethods,
  SETTLEMENT_MODEL_PAYMENT_METHODS,
  type CartQuoteRequest,
  type CheckoutRequest,
  type GatewayPaymentMethod,
  type PaymentMethod,
  type ShopPaymentMethod,
  type DomainEvent,
  type Order,
  type SettlementModel,
} from '@hamro-pasal/shared-types';
import { and, asc, avg, count, eq, gt, gte, inArray, isNull, lte, sql } from 'drizzle-orm';

import { deliveryFeePaisa, haversineKm, type DeliveryTerms } from './delivery-fee';
import { isCheckViolation, isUniqueViolation } from '../infra/pg-errors';
import type { SettlementService } from '../ledger/settlement-service';
import type { VendorGatewayAccountService } from '../payments/gateway-accounts';
import type { RedisKeyedMutex } from '../infra/redis-mutex';
import {
  InsufficientStockError,
  ProductCategoryHiddenError,
  ProductUnavailableError,
  ReservationExpiredError,
} from '../inventory/errors';
import { toNpr, toPaisa } from '../ledger/money';
import { reviewIsPublic } from '../reviews/review-visibility';
import { enqueueOrderStateChanged } from '../orders/order-events';
import { generateDeliveryOtp, hashDeliveryOtp } from './delivery-otp';
import { deliversTo, enabledModes } from '../catalog/catalog-service';
import {
  CheckoutRejectedError,
  priceCart,
  pricedCartView,
  type CampaignOffer,
  type PricedCart,
  type VendorOfferRule,
} from './pricing';
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
/** A priced cart and what the customer may pay it with (POST /api/cart/quote). */
export interface CartQuote {
  readonly priced: PricedCart;
  readonly distanceKm: number;
  /** Step 7.2: the shop's free-delivery threshold; null when none, or under platform delivery. */
  readonly freeDeliveryThresholdNpr: number | null;
  /** False when delivery is switched off, for everyone or for this shop: checkout would refuse. */
  readonly deliveryAvailable: boolean;
  readonly paymentOptions: readonly {
    readonly method: PaymentMethod;
    readonly available: boolean;
    readonly reason?: PaymentRefusal | 'DELIVERY_UNAVAILABLE';
  }[];
}

/** Why a payment method is not available for one cart (SPEC core 9, "Payment routing"). */
export type PaymentRefusal =
  | 'SETTLEMENT_MODEL'
  | 'NOT_ACCEPTED_BY_SHOP'
  | 'BELOW_PREPAID_RESERVE'
  | 'GATEWAY_NOT_VERIFIED'
  | 'COD_NOT_AVAILABLE'
  | 'INSUFFICIENT_WALLET_BALANCE';

/** What the routing of one cart depends on besides the shop's model and accepted methods. */
export interface RoutingContext {
  /** Model C: the gateways whose merchant account a Super Admin has verified. */
  readonly verifiedGateways: readonly GatewayPaymentMethod[];
  /** Model C: the prepaid balance less this order's fee stays at or above the Fixed Reserve. */
  readonly reserveHolds: boolean;
  readonly codEligible: boolean;
  /** The customer's wallet holds the order's total. */
  readonly walletCovers: boolean;
}

export class CheckoutService {
  constructor(
    private readonly db: Database,
    private readonly locks: InventoryLockService,
    private readonly mutex: RedisKeyedMutex,
    private readonly settlement: SettlementService,
    private readonly gatewayAccounts: VendorGatewayAccountService,
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

    const { vendor, items, priced } = await this.price(request);
    // The customer agreed to a total; an offer or campaign that ended since then changes it. The
    // amount sent is only compared, never used as a price.
    if (
      request.expected_total_npr !== undefined &&
      toPaisa(request.expected_total_npr) !== priced.totalPaisa
    ) {
      throw quoteChanged(priced);
    }
    assertPaymentMethodOffered(
      vendor,
      request.payment_method,
      await this.routingContext(customerId, vendor, priced, request.payment_method),
    );

    const otp = generateDeliveryOtp();
    const otpHash = await hashDeliveryOtp(otp);
    const reservation = await this.locks.reserve({ vendorId: vendor.id, customerId, items });

    let order: Order;
    try {
      order = await this.db.transaction(async (tx) => {
        // The model is read again under a lock on the vendor row, the row a settlement model
        // approval locks FOR UPDATE: the approval either committed before this read (and the
        // order takes the new model, or is refused if that model does not take the method), or
        // it waits for this order and then counts it as open.
        const [shop] = await tx
          .select({
            status: vendors.status,
            settlement_model: vendors.settlement_model,
            accepted_payment_methods: vendors.accepted_payment_methods,
            wallet_balance_npr: vendors.wallet_balance_npr,
          })
          .from(vendors)
          .where(eq(vendors.id, vendor.id))
          .for('key share');
        if (shop === undefined) throw new Error(`Vendor ${vendor.id} vanished during checkout`);
        // Phase 36: a shop that closed (or was suspended) since the cart was priced takes no
        // order. A deactivation holds this row FOR UPDATE: it either committed first (refused
        // here) or waits and then counts this order as open.
        if (shop.status !== 'LIVE') {
          throw new CheckoutRejectedError(
            'VENDOR_UNAVAILABLE',
            'This vendor is not accepting orders',
          );
        }
        // The model, the accepted methods, the verified gateways and the prepaid balance are read
        // again under the vendor lock. The COD rating was checked above, and the wallet's own
        // CHECK refuses an overdraft below.
        assertPaymentMethodOffered(shop, request.payment_method, {
          verifiedGateways: await this.gatewayAccounts.verifiedGateways(tx, vendor.id),
          reserveHolds: await reserveHolds(tx, shop, priced.commissionPaisa),
          codEligible: true,
          walletCovers: true,
        });
        // Lock order of a checkout: vendor row (above), vendor offer row, opt-in row, each
        // FOR SHARE or weaker, then the inserts.
        //
        // A vendor is charged for a discount only under a rule its own account switched on and
        // has not switched off (SPEC core 7). Both rules are read again under a lock: one that
        // ended since the cart was priced means the customer was quoted a total that no longer
        // holds, and no order is created for it.
        const vendorOffer = priced.vendorOffer;
        if (vendorOffer !== null) {
          // Ending an offer takes the vendor row FOR UPDATE first, so it either committed before
          // the key-share lock above or waits for this order.
          const [offer] = await tx
            .select({
              running: sql<boolean>`${vendorOffers.ended_at} IS NULL
                AND (${vendorOffers.ends_at} IS NULL OR ${vendorOffers.ends_at} > now())`,
            })
            .from(vendorOffers)
            .where(
              and(
                eq(vendorOffers.id, vendorOffer.offer.offerId),
                eq(vendorOffers.vendor_id, vendor.id),
              ),
            )
            .for('share');
          if (offer?.running !== true) throw quoteChanged();
        }
        const promo = priced.promo;
        if (promo !== null) {
          const [optIn] = await tx
            .select({ status: campaignOptIns.status })
            .from(campaignOptIns)
            .where(eq(campaignOptIns.id, promo.offer.optInId))
            .for('share');
          if (optIn?.status !== 'ACTIVE') throw quoteChanged();
        }
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
            ...(vendorOffer === null
              ? {}
              : {
                  vendor_offer_id: vendorOffer.offer.offerId,
                  vendor_offer_discount_npr: toNpr(vendorOffer.discountPaisa),
                }),
            ...(promo === null
              ? {}
              : {
                  platform_promo_discount_npr: toNpr(promo.discountPaisa),
                  platform_promo_vendor_share_npr: toNpr(promo.vendorSharePaisa),
                  campaign_opt_in_id: promo.offer.optInId,
                  discount_snapshot: {
                    campaign_id: promo.offer.campaignId,
                    name: promo.offer.name,
                    kind: promo.offer.kind,
                    value: promo.offer.value,
                    max_discount_npr: promo.offer.maxDiscountNpr,
                    min_cart_npr: promo.offer.minCartNpr,
                    vendor_share_percent: promo.offer.vendorSharePercent,
                    terms_version: promo.offer.termsVersion,
                  },
                }),
            fulfillment_locked: vendor.fulfillment_mode,
            settlement_model_locked: shop.settlement_model,
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
        // 2026-10-21 (SPEC core 12): a wallet order is paid here, in the order's own transaction,
        // routed exactly as a gateway payment (escrow for Model B, the shop's prepaid balance for
        // Model C). The wallet's CHECK refuses a payment it cannot cover.
        let paidRow = created;
        if (created.payment_method === 'WALLET') {
          await this.settlement.capturePaymentInTransaction(tx, created);
          paidRow = { ...created, payment_status: 'PAID' };
        }
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
        return paidRow;
      });
    } catch (error: unknown) {
      // Redis and PostgreSQL cannot commit together: never leave an orphaned lock behind.
      await this.locks.release(vendor.id, reservation.id);
      if (isUniqueViolation(error, 'orders_idempotency_key_key')) {
        const winner = await this.findByIdempotencyKey(request.idempotency_key);
        if (winner !== undefined) return this.replay(customerId, winner);
      }
      if (isCheckViolation(error, 'ledger_accounts_customer_wallet_non_negative_check')) {
        throw insufficientWallet(priced.totalPaisa);
      }
      throw error;
    }

    if (order.payment_method === 'COD' || order.payment_method === 'WALLET') {
      try {
        const placed = await this.claim({
          orderId: order.id,
          vendorId: vendor.id,
          reservationId: reservation.id,
        });
        order = placed.order;
      } catch (error: unknown) {
        // A wallet order was paid in its own transaction: if it cannot be placed (the lock or the
        // stock went in the meantime), the money goes straight back to the wallet.
        if (order.payment_method === 'WALLET') await this.failWalletOrder(order.id);
        throw error;
      }
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

  /**
   * POST /api/cart/quote: the cart exactly as checkout will price it, and the payment methods
   * checkout will accept. It takes no lock, creates no order and changes nothing.
   *
   * With delivery switched off (the Emergency Stop, or this shop's own mode) it still answers,
   * with `deliveryAvailable: false` and no payment method available, so the app can say
   * "Delivery Unavailable" beside the cart. Checkout refuses such an order (422).
   */
  async quote(customerId: string, request: CartQuoteRequest): Promise<CartQuote> {
    const { vendor, priced, distanceKm, deliveryAvailable } = await this.price(request, true);
    const context = await this.routingContext(customerId, vendor, priced, null);
    return {
      priced,
      distanceKm,
      freeDeliveryThresholdNpr:
        vendor.fulfillment_mode === 'SELF_DELIVERY' ? vendor.free_delivery_above_npr : null,
      deliveryAvailable,
      paymentOptions: paymentMethods.map((method) => {
        if (!deliveryAvailable) {
          return { method, available: false, reason: 'DELIVERY_UNAVAILABLE' as const };
        }
        const refusal = paymentRefusal(vendor, method, context);
        return refusal === null
          ? { method, available: true }
          : { method, available: false, reason: refusal };
      }),
    };
  }

  /**
   * The one pricing path (SPEC core 9, "The server prices the order"): the quote and checkout both
   * run it, so a quoted total is the total checkout charges. In order: the shop is LIVE; delivery
   * is available and the shop's mode enabled; the address is inside its delivery area; every item
   * is its own, active and in stock; then database prices, the minimum order value and the
   * delivery charge of the shop's settings.
   */
  private async price(request: CartQuoteRequest, tolerateDeliveryOff = false) {
    const [vendor] = await this.db.select().from(vendors).where(eq(vendors.id, request.vendor_id));
    if (vendor?.status !== 'LIVE') {
      throw new CheckoutRejectedError('VENDOR_UNAVAILABLE', 'This vendor is not accepting orders');
    }
    const modes = await enabledModes(this.db);
    const deliveryAvailable = modes.includes(vendor.fulfillment_mode);
    if (!deliveryAvailable && !tolerateDeliveryOff) {
      if (modes.length === 0) {
        throw new CheckoutRejectedError(
          'DELIVERY_UNAVAILABLE',
          'Delivery is unavailable at the moment. Please try again later.',
        );
      }
      throw new CheckoutRejectedError('VENDOR_UNAVAILABLE', 'This vendor is not accepting orders');
    }
    // Step 7.3: outside its hours, switched Closed, or auto-paused, a shop takes no order.
    const [open] = await this.db
      .select({ reason: vendorClosedReason() })
      .from(vendors)
      .where(eq(vendors.id, vendor.id));
    if (open?.reason != null) {
      throw new CheckoutRejectedError('VENDOR_UNAVAILABLE', 'This shop is closed right now', {
        reason: open.reason,
      });
    }
    const address = request.delivery_address;
    const [area] = await this.db
      .select({
        delivers: deliversTo(
          {
            lat: address.exact_lat,
            lng: address.exact_lng,
            municipality_palika_string: address.municipality_palika_string,
          },
          // A quote with delivery switched off still checks the shop's own scope, under its mode.
          deliveryAvailable ? modes : [vendor.fulfillment_mode],
        ),
      })
      .from(vendors)
      .where(eq(vendors.id, vendor.id));
    if (area?.delivers !== true) {
      throw new CheckoutRejectedError(
        'OUTSIDE_DELIVERY_AREA',
        'This shop does not deliver to your selected address',
      );
    }

    const items = mergeLines(request.items);
    const catalogue = await this.db
      .select({
        id: products.id,
        name: products.name,
        price_npr: products.price_npr,
        stock_quantity: products.stock_quantity,
      })
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
    // Decided 2026-10-20: an item whose category, or any category above it, the Super Admin has
    // hidden since it was put in the cart cannot be ordered. The quote and the checkout both come
    // through here, so the cart shows the refusal before the customer pays.
    const hidden = await this.db
      .select({ id: products.id, name: products.name })
      .from(products)
      .where(
        and(
          inArray(
            products.id,
            catalogue.map((p) => p.id),
          ),
          sql`NOT ${inVisibleCategory(products.category_id)}`,
        ),
      )
      .orderBy(asc(products.name));
    if (hidden.length > 0) throw new ProductCategoryHiddenError(hidden);
    assertInStock(byId, items);

    const [settings] = await this.db
      .select({ platformFeeNpr: platformSettings.platform_delivery_fee_npr })
      .from(platformSettings);
    if (settings === undefined) throw new Error('platform_settings row is missing');
    const distanceKm = haversineKm(vendor.location, { x: address.exact_lng, y: address.exact_lat });
    const terms: DeliveryTerms = {
      fulfillmentMode: vendor.fulfillment_mode,
      deliveryScope: vendor.delivery_scope,
      baseFeeNpr: vendor.base_delivery_fee_npr,
      perKmFeeNpr: vendor.delivery_fee_per_km_npr,
      freeAboveNpr: vendor.free_delivery_above_npr,
      platformFeeNpr: settings.platformFeeNpr,
    };
    const priced = priceCart(
      vendor,
      byId,
      items,
      (subtotalPaisa) => deliveryFeePaisa(terms, subtotalPaisa, distanceKm),
      await this.runningCampaigns(vendor.id),
      await this.runningVendorOffers(vendor.id),
    );
    return { vendor, items, priced, distanceKm, deliveryAvailable };
  }

  /**
   * The platform campaigns that apply to a shop now: published, inside their dates on the
   * database clock, and joined by the shop's own ACTIVE opt-in to their current terms. A campaign
   * discounts nothing for a shop without that row (SPEC verification 6).
   */
  private async runningCampaigns(vendorId: string): Promise<CampaignOffer[]> {
    return this.db
      .select({
        campaignId: platformCampaigns.id,
        optInId: campaignOptIns.id,
        optedInAt: campaignOptIns.opted_in_at,
        name: platformCampaigns.name,
        kind: platformCampaigns.kind,
        value: platformCampaigns.value,
        maxDiscountNpr: platformCampaigns.max_discount_npr,
        minCartNpr: platformCampaigns.min_cart_npr,
        vendorSharePercent: platformCampaigns.vendor_share_percent,
        termsVersion: platformCampaigns.terms_version,
      })
      .from(campaignOptIns)
      .innerJoin(platformCampaigns, eq(platformCampaigns.id, campaignOptIns.campaign_id))
      .where(
        and(
          eq(campaignOptIns.vendor_id, vendorId),
          eq(campaignOptIns.status, 'ACTIVE'),
          eq(campaignOptIns.opt_in_terms_version, platformCampaigns.terms_version),
          eq(platformCampaigns.is_active, true),
          lte(platformCampaigns.starts_at, sql`now()`),
          gt(platformCampaigns.ends_at, sql`now()`),
        ),
      );
  }

  /**
   * The shop's own offers that apply now: not ended by the shop, and inside their dates on the
   * database clock. At most MAX_LIVE_VENDOR_OFFERS rows (the limit is enforced at creation).
   */
  private async runningVendorOffers(vendorId: string): Promise<VendorOfferRule[]> {
    return this.db
      .select({
        offerId: vendorOffers.id,
        createdAt: vendorOffers.created_at,
        label: vendorOffers.label,
        kind: vendorOffers.kind,
        value: vendorOffers.value,
        maxDiscountNpr: vendorOffers.max_discount_npr,
        minCartNpr: vendorOffers.min_cart_npr,
      })
      .from(vendorOffers)
      .where(
        and(
          eq(vendorOffers.vendor_id, vendorId),
          isNull(vendorOffers.ended_at),
          lte(vendorOffers.starts_at, sql`now()`),
          sql`(${vendorOffers.ends_at} IS NULL OR ${vendorOffers.ends_at} > now())`,
        ),
      );
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
      const candidate = generateDeliveryOtp();
      // Re-checked in the UPDATE: a delivery that commits meanwhile erased the hash for good, and
      // a new one must not be written onto the delivered order.
      const rotated = await this.db
        .update(orders)
        .set({ delivery_otp: await hashDeliveryOtp(candidate) })
        .where(and(eq(orders.id, order.id), inArray(orders.state, [...OTP_ROTATABLE_STATES])))
        .returning({ id: orders.id });
      deliveryOtp = rotated.length > 0 ? candidate : null;
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
   * What routing needs beyond the shop's model and methods. `only` (checkout) limits the work to
   * the method asked for: the COD rating for COD, the wallet balance for WALLET.
   */
  private async routingContext(
    customerId: string,
    vendor: typeof vendors.$inferSelect,
    priced: PricedCart,
    only: PaymentMethod | null,
  ): Promise<RoutingContext> {
    let codEligible = true;
    if (only === null || only === 'COD') {
      try {
        await this.assertCodEligible(customerId);
      } catch (error) {
        if (!(error instanceof CheckoutRejectedError)) throw error;
        codEligible = false;
      }
    }
    return {
      verifiedGateways:
        vendor.settlement_model === 'DIRECT_PREPAID'
          ? await this.gatewayAccounts.verifiedGateways(this.db, vendor.id)
          : [],
      reserveHolds: await reserveHolds(this.db, vendor, priced.commissionPaisa),
      codEligible,
      walletCovers:
        only === null || only === 'WALLET'
          ? (await customerWalletPaisa(this.db, customerId)) >= priced.totalPaisa
          : true,
    };
  }

  /**
   * A paid wallet order that could not be placed: FAILED, and the payment reversed to the
   * customer's wallet in the same transaction (nothing is owed by hand).
   */
  private async failWalletOrder(orderId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [locked] = await tx.select().from(orders).where(eq(orders.id, orderId)).for('update');
      if (locked?.state !== 'PENDING_PAYMENT') return; // placed after all, or already failed
      await this.settlement.reversePaymentInTransaction(tx, locked);
      const [failed] = await tx
        .update(orders)
        .set({ state: 'FAILED' })
        .where(eq(orders.id, locked.id))
        .returning();
      if (failed !== undefined) await enqueueOrderStateChanged(tx, 'PENDING_PAYMENT', failed);
    });
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
      // Model C (2026-10-21): the platform's fee leaves the prepaid balance as the order is placed.
      await this.settlement.debitOrderFeeInTransaction(tx, updated);

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

/**
 * 409 QUOTE_CHANGED: the total the customer saw no longer holds. With the cart as it is priced
 * now when that is known (`details.quote`); the app asks for a new quote otherwise.
 */
function quoteChanged(priced?: PricedCart): CheckoutRejectedError {
  return new CheckoutRejectedError(
    'QUOTE_CHANGED',
    'The offer on this cart has just ended. Review the new total.',
    priced === undefined ? undefined : { quote: pricedCartView(priced) },
    409,
  );
}

interface RoutedShop {
  readonly settlement_model: SettlementModel;
  readonly accepted_payment_methods: readonly ShopPaymentMethod[];
}

/** A shop accepts the customer wallet wherever it accepts eSewa or Khalti (2026-10-21). */
function shopAccepts(shop: RoutedShop, method: PaymentMethod): boolean {
  if (method === 'WALLET') {
    return (
      shop.accepted_payment_methods.includes('ESEWA') ||
      shop.accepted_payment_methods.includes('KHALTI')
    );
  }
  return shop.accepted_payment_methods.includes(method);
}

/**
 * The methods a shop takes (SPEC core 9, "Payment routing"): what its settlement model allows,
 * narrowed by what the shop itself accepts. In the order customers see them.
 */
export function offeredPaymentMethods(shop: RoutedShop): PaymentMethod[] {
  const routed = SETTLEMENT_MODEL_PAYMENT_METHODS[shop.settlement_model];
  return paymentMethods.filter((method) => routed.includes(method) && shopAccepts(shop, method));
}

/**
 * Why a method cannot pay this cart, or null. In order: the settlement model, the shop's own
 * methods, Model C's Fixed Reserve and verified merchant accounts, the customer's COD rating, the
 * customer's wallet balance.
 */
export function paymentRefusal(
  shop: RoutedShop,
  method: PaymentMethod,
  context: RoutingContext,
): PaymentRefusal | null {
  if (!SETTLEMENT_MODEL_PAYMENT_METHODS[shop.settlement_model].includes(method)) {
    return 'SETTLEMENT_MODEL';
  }
  if (!shopAccepts(shop, method)) return 'NOT_ACCEPTED_BY_SHOP';
  if (shop.settlement_model === 'DIRECT_PREPAID') {
    if (!context.reserveHolds) return 'BELOW_PREPAID_RESERVE';
    if (isGatewayPaymentMethod(method) && !context.verifiedGateways.includes(method)) {
      return 'GATEWAY_NOT_VERIFIED';
    }
  }
  if (method === 'COD' && !context.codEligible) return 'COD_NOT_AVAILABLE';
  if (method === 'WALLET' && !context.walletCovers) return 'INSUFFICIENT_WALLET_BALANCE';
  return null;
}

function assertPaymentMethodOffered(
  shop: RoutedShop,
  method: PaymentMethod,
  context: RoutingContext,
): void {
  const refusal = paymentRefusal(shop, method, context);
  if (refusal === null) return;
  if (refusal === 'COD_NOT_AVAILABLE') {
    throw new CheckoutRejectedError(
      'COD_NOT_AVAILABLE',
      'Cash on delivery is not available for this account',
    );
  }
  if (refusal === 'INSUFFICIENT_WALLET_BALANCE') throw insufficientWallet(null);
  const messages: Record<typeof refusal, string> = {
    SETTLEMENT_MODEL: 'This shop takes cash on delivery only',
    NOT_ACCEPTED_BY_SHOP: 'This shop does not accept that payment method',
    GATEWAY_NOT_VERIFIED: 'This shop cannot take that payment method right now',
    BELOW_PREPAID_RESERVE: 'This shop cannot take orders right now',
  };
  throw new CheckoutRejectedError('PAYMENT_METHOD_UNAVAILABLE', messages[refusal], {
    accepted: offeredPaymentMethods(shop),
    reason: refusal,
    settlement_model: shop.settlement_model,
  });
}

/** 422 INSUFFICIENT_WALLET_BALANCE: the customer's wallet does not hold the order's total. */
function insufficientWallet(totalPaisa: number | null): CheckoutRejectedError {
  return new CheckoutRejectedError(
    'INSUFFICIENT_WALLET_BALANCE',
    'Your wallet does not hold enough for this order',
    totalPaisa === null ? undefined : { total_npr: toNpr(totalPaisa) },
  );
}

type Reader = Pick<Database, 'select'>;

/** A customer's wallet balance, in paisa (0 before its first recharge). */
export async function customerWalletPaisa(executor: Reader, customerId: string): Promise<number> {
  const [account] = await executor
    .select({ balance: ledgerAccounts.balance_npr })
    .from(ledgerAccounts)
    .where(eq(ledgerAccounts.customer_user_id, customerId));
  return account === undefined ? 0 : toPaisa(account.balance);
}

/**
 * Model C (SPEC core 9): the shop's prepaid balance after this order's fee stays at or above the
 * Fixed Reserve. True for every other model.
 */
async function reserveHolds(
  executor: Reader,
  shop: { readonly settlement_model: SettlementModel; readonly wallet_balance_npr: number },
  feePaisa: number,
): Promise<boolean> {
  if (shop.settlement_model !== 'DIRECT_PREPAID') return true;
  const [settings] = await executor
    .select({ reserve: platformSettings.prepaid_reserve_npr })
    .from(platformSettings);
  if (settings === undefined) throw new Error('platform_settings row is missing');
  return toPaisa(shop.wallet_balance_npr) - feePaisa >= toPaisa(settings.reserve);
}

/**
 * The checkout stock guard (Phase 17): no order for more than `products.stock_quantity`. It runs
 * before pricing, the COD check and the lock, and reports every short line with what is on hand.
 * The Redis lock then re-checks against other customers' live holds, and the claim's guarded
 * decrement is the final word in PostgreSQL.
 */
export function assertInStock(
  onHand: ReadonlyMap<string, { readonly stock_quantity: number }>,
  items: readonly { readonly productId: string; readonly quantity: number }[],
): void {
  const shortfalls = items.flatMap((line) => {
    const available = onHand.get(line.productId)?.stock_quantity ?? 0;
    return available < line.quantity
      ? [{ productId: line.productId, requested: line.quantity, available }]
      : [];
  });
  if (shortfalls.length > 0) {
    throw new InsufficientStockError(shortfalls);
  }
}

function mergeLines(items: CheckoutRequest['items']): { productId: string; quantity: number }[] {
  const merged = new Map<string, number>();
  for (const item of items) {
    merged.set(item.product_id, (merged.get(item.product_id) ?? 0) + item.quantity);
  }
  return [...merged].map(([productId, quantity]) => ({ productId, quantity }));
}
