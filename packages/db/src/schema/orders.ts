import {
  GEO_SRID,
  NEPAL_PROVINCE_ID_MAX,
  NEPAL_PROVINCE_ID_MIN,
  type AuditState,
} from '@hamro-pasal/shared-types';
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

import { createdAt, geoPoint, npr, primaryId, updatedAt } from './columns';
import {
  fulfillmentModeEnum,
  orderStateEnum,
  paymentMethodEnum,
  paymentStatusEnum,
  settlementModelEnum,
} from './enums';
import { campaignOptIns, vendorOffers } from './marketing';
import { users } from './users';
import { products, vendors } from './vendors';

/** SPEC `OrderSnapshot`. */
export const orders = pgTable(
  'orders',
  {
    id: primaryId(),
    idempotency_key: text().notNull(),
    customer_id: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    vendor_id: uuid()
      .notNull()
      .references(() => vendors.id, { onDelete: 'restrict' }),
    reservation_id: uuid(),
    driver_user_id: uuid().references(() => users.id, { onDelete: 'restrict' }),
    state: orderStateEnum().notNull().default('PENDING_PAYMENT'),
    subtotal: npr().notNull(),
    delivery_fee: npr().notNull(),
    platform_commission_amount: npr().notNull(),
    /**
     * The vendor's own offer the order was priced with (SPEC core 7). The row is immutable (a
     * trigger of migration 0034), so the id is the rule exactly as applied.
     */
    vendor_offer_id: uuid().references(() => vendorOffers.id, { onDelete: 'restrict' }),
    /** What that offer took off the subtotal; the vendor funds all of it. 0 without an offer. */
    vendor_offer_discount_npr: npr().notNull().default(0),
    /**
     * The platform campaign discount (SPEC core 9), calculated on the subtotal after the vendor
     * offer: the customer pays subtotal − vendor offer − this + delivery fee. 0 without a
     * campaign. Written once, at checkout, with the order.
     */
    platform_promo_discount_npr: npr().notNull().default(0),
    /** The part of the discount the vendor bears (its opt-in's `vendor_share_percent`). */
    platform_promo_vendor_share_npr: npr().notNull().default(0),
    /** The vendor's own opt-in the discount was priced under (SPEC core 7: dispute-proof). */
    campaign_opt_in_id: uuid().references(() => campaignOptIns.id, { onDelete: 'restrict' }),
    /** The campaign rule exactly as applied. */
    discount_snapshot: jsonb().$type<AuditState>(),
    fulfillment_locked: fulfillmentModeEnum().notNull(),
    /**
     * The shop's settlement model when the order was created (SPEC core 5). Checkout writes it
     * under a lock on the vendor row; a trigger refuses any later change.
     */
    settlement_model_locked: settlementModelEnum().notNull().default('PLATFORM_ESCROW'),
    payment_method: paymentMethodEnum().notNull(),
    payment_status: paymentStatusEnum().notNull().default('PENDING'),
    payment_gateway_ref: text(),
    /** bcrypt hash; cleared at DELIVERED so a used code cannot be replayed. */
    delivery_otp: text(),
    /** When the order became PLACED (COD accepted or payment confirmed). Starts the 60 s window. */
    placed_at: timestamp({ withTimezone: true, mode: 'date' }),
    delivered_at: timestamp({ withTimezone: true, mode: 'date' }),
    /** Phase 22: stamped by the nightly reconciliation once the settlement journal is verified. */
    reconciled_at: timestamp({ withTimezone: true, mode: 'date' }),
    refund_required: boolean().notNull().default(false),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (t) => [
    // Idempotency guard: a retried checkout submission cannot create a second order.
    unique('orders_idempotency_key_key').on(t.idempotency_key),
    // Idempotency guard: one order per gateway transaction (eSewa transaction_uuid / Khalti pidx).
    unique('orders_payment_gateway_ref_key').on(t.payment_method, t.payment_gateway_ref),
    // Target for composite FKs that must agree with the order's vendor (e.g. wallet ledger).
    unique('orders_id_vendor_id_key').on(t.id, t.vendor_id),
    // One order per inventory lock.
    unique('orders_reservation_id_key').on(t.reservation_id),
    index('orders_customer_id_idx').on(t.customer_id),
    index('orders_vendor_id_state_idx').on(t.vendor_id, t.state),
    // The nightly reconciliation's work queue.
    index('orders_unreconciled_idx')
      .on(t.delivered_at, t.id)
      .where(sql`${t.state} = 'DELIVERED' AND ${t.reconciled_at} IS NULL`),
    index('orders_vendor_id_reconciled_at_idx').on(t.vendor_id, t.reconciled_at),
    // Phase 35: a shop's deliveries by time (the analytics summary's day and 30-day windows).
    index('orders_vendor_id_delivered_at_idx')
      .on(t.vendor_id, t.delivered_at)
      .where(sql`${t.delivered_at} IS NOT NULL`),
    // Phase 23: serves the users FK check (and a rider's own orders); most orders have no rider.
    index('orders_driver_user_id_idx')
      .on(t.driver_user_id)
      .where(sql`${t.driver_user_id} IS NOT NULL`),
    check('orders_idempotency_key_check', sql`btrim(${t.idempotency_key}) <> ''`),
    check('orders_subtotal_check', sql`${t.subtotal} >= 0`),
    check('orders_delivery_fee_check', sql`${t.delivery_fee} >= 0`),
    check('orders_platform_commission_check', sql`${t.platform_commission_amount} >= 0`),
    index('orders_campaign_opt_in_id_idx')
      .on(t.campaign_opt_in_id)
      .where(sql`${t.campaign_opt_in_id} IS NOT NULL`),
    index('orders_vendor_offer_id_idx')
      .on(t.vendor_offer_id)
      .where(sql`${t.vendor_offer_id} IS NOT NULL`),
    // No vendor offer discount without the offer it came from, and the two discounts together
    // never exceed the goods.
    check(
      'orders_vendor_offer_check',
      sql`${t.vendor_offer_discount_npr} >= 0
            AND (${t.vendor_offer_discount_npr} > 0) = (${t.vendor_offer_id} IS NOT NULL)
            AND ${t.vendor_offer_discount_npr} + ${t.platform_promo_discount_npr} <= ${t.subtotal}`,
    ),
    // A discount never exceeds the goods, and the vendor never bears more than the discount.
    check(
      'orders_platform_promo_check',
      sql`${t.platform_promo_discount_npr} >= 0
            AND ${t.platform_promo_discount_npr} <= ${t.subtotal}
            AND ${t.platform_promo_vendor_share_npr} >= 0
            AND ${t.platform_promo_vendor_share_npr} <= ${t.platform_promo_discount_npr}`,
    ),
    // No discount without the vendor's own opt-in and the rule as applied, and none of them alone.
    check(
      'orders_platform_promo_source_check',
      sql`(${t.platform_promo_discount_npr} > 0) = (${t.campaign_opt_in_id} IS NOT NULL)
            AND (${t.campaign_opt_in_id} IS NULL) = (${t.discount_snapshot} IS NULL)`,
    ),
    check(
      'orders_cod_has_no_gateway_ref_check',
      sql`${t.payment_method} <> 'COD' OR ${t.payment_gateway_ref} IS NULL`,
    ),
    // Settlement pays the delivery fee to the rider, so a fleet order cannot be DELIVERED without one.
    check(
      'orders_fleet_delivered_has_driver_check',
      sql`${t.fulfillment_locked} = 'SELF_DELIVERY' OR ${t.state} <> 'DELIVERED' OR ${t.driver_user_id} IS NOT NULL`,
    ),
    // SPEC: delivery_otp is stored as a bcrypt hash only, never the raw 4-digit code.
    check('orders_delivery_otp_bcrypt_check', sql`${t.delivery_otp} ~ '^\\$2[aby]\\$'`),
    // The handoff code is erased only by the delivery that used it: until then it must exist.
    check(
      'orders_delivery_otp_present_check',
      sql`${t.delivery_otp} IS NOT NULL OR ${t.state} IN ('DELIVERED', 'DISPUTED')`,
    ),
    // placed_at is stamped exactly when the order leaves PENDING_PAYMENT for PLACED. Only an
    // order still paying, or one that FAILED before it was ever placed, can lack it.
    check(
      'orders_placed_at_check',
      sql`CASE ${t.state} WHEN 'PENDING_PAYMENT' THEN ${t.placed_at} IS NULL WHEN 'FAILED' THEN true ELSE ${t.placed_at} IS NOT NULL END`,
    ),
    // Only a delivered order's settlement can be reconciled.
    check(
      'orders_reconciled_at_check',
      sql`${t.reconciled_at} IS NULL OR ${t.state} IN ('DELIVERED', 'DISPUTED')`,
    ),
    // Only money that was actually captured can be owed back.
    check(
      'orders_refund_required_paid_check',
      sql`NOT ${t.refund_required} OR ${t.payment_status} = 'PAID'`,
    ),
  ],
);

/**
 * The delivery address captured at checkout (Nepal hierarchy + dropped pin). A copy, not a
 * reference to customer_addresses, so editing a saved address never rewrites an order.
 */
export const orderAddresses = pgTable(
  'order_addresses',
  {
    order_id: uuid()
      .primaryKey()
      .references(() => orders.id, { onDelete: 'cascade' }),
    province_id: smallint().notNull(),
    district_string: text().notNull(),
    municipality_palika_string: text().notNull(),
    ward_number: integer().notNull(),
    tole_locality: text().notNull(),
    landmark: text().notNull(),
    exact_lat: doublePrecision().notNull(),
    exact_lng: doublePrecision().notNull(),
    // Derived from the pin so the geometry can never disagree with exact_lat/exact_lng.
    location: geoPoint()
      .notNull()
      .generatedAlwaysAs(
        sql`ST_SetSRID(ST_MakePoint("exact_lng", "exact_lat"), ${sql.raw(String(GEO_SRID))})`,
      ),
    created_at: createdAt(),
  },
  (t) => [
    index('order_addresses_location_gist').using('gist', t.location),
    check(
      'order_addresses_province_check',
      sql`${t.province_id} BETWEEN ${sql.raw(String(NEPAL_PROVINCE_ID_MIN))} AND ${sql.raw(String(NEPAL_PROVINCE_ID_MAX))}`,
    ),
    check('order_addresses_ward_check', sql`${t.ward_number} >= 1`),
    check('order_addresses_lat_check', sql`${t.exact_lat} BETWEEN -90 AND 90`),
    check('order_addresses_lng_check', sql`${t.exact_lng} BETWEEN -180 AND 180`),
  ],
);

export const orderItems = pgTable(
  'order_items',
  {
    id: primaryId(),
    order_id: uuid()
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    product_id: uuid()
      .notNull()
      .references(() => products.id, { onDelete: 'restrict' }),
    product_name: text().notNull(),
    unit_price_npr: npr().notNull(),
    quantity: integer().notNull(),
    created_at: createdAt(),
  },
  (t) => [
    unique('order_items_order_id_product_id_key').on(t.order_id, t.product_id),
    index('order_items_product_id_idx').on(t.product_id),
    check('order_items_product_name_check', sql`btrim(${t.product_name}) <> ''`),
    check('order_items_unit_price_check', sql`${t.unit_price_npr} > 0`),
    check('order_items_quantity_check', sql`${t.quantity} > 0`),
  ],
);
