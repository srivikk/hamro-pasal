import {
  adBillingModels,
  adPurchaseStatuses,
  adSlots,
  campaignOptInStatuses,
  discountKinds,
  type AuditState,
} from '@hamro-pasal/shared-types';
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { createdAt, npr, primaryId, updatedAt } from './columns';
import { settlementModelEnum } from './enums';
import { users } from './users';
import { vendors } from './vendors';

export const discountKindEnum = pgEnum('discount_kind', discountKinds);
export const campaignOptInStatusEnum = pgEnum('campaign_opt_in_status', campaignOptInStatuses);
export const adSlotEnum = pgEnum('ad_slot', adSlots);
export const adBillingModelEnum = pgEnum('ad_billing_model', adBillingModels);
export const adPurchaseStatusEnum = pgEnum('ad_purchase_status', adPurchaseStatuses);

/**
 * Phase 26: a platform campaign (SPEC core 7). It applies to no shop until that shop's own
 * account opts in (`campaign_opt_ins`).
 *
 * The seven terms are `kind`, `value`, `max_discount_npr`, `min_cart_npr`, `vendor_share_percent`,
 * `starts_at` and `ends_at`. The triggers of migration 0024 let any of them change only together
 * with `terms_version + 1`, and a raised version voids every ACTIVE opt-in in the same statement.
 * `name` and `is_active` are not terms.
 */
export const platformCampaigns = pgTable(
  'platform_campaigns',
  {
    id: primaryId(),
    name: text().notNull(),
    kind: discountKindEnum().notNull(),
    /** NPR for FLAT; percent for PERCENTAGE. */
    value: numeric({ precision: 12, scale: 2, mode: 'number' }).notNull(),
    /** The most one order is discounted; PERCENTAGE only. */
    max_discount_npr: npr(),
    /** The minimum order value (cart subtotal) the campaign applies from. */
    min_cart_npr: npr().notNull().default(0),
    /** The share of each discount the vendor bears; the platform funds the rest. */
    vendor_share_percent: numeric({ precision: 5, scale: 2, mode: 'number' }).notNull(),
    terms_version: integer().notNull().default(1),
    starts_at: timestamp({ withTimezone: true, mode: 'date' }).notNull(),
    ends_at: timestamp({ withTimezone: true, mode: 'date' }).notNull(),
    /** Published: shops see the invite. */
    is_active: boolean().notNull().default(true),
    created_by_user_id: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (t) => [
    index('platform_campaigns_created_by_user_id_idx').on(t.created_by_user_id),
    // The campaigns running at a moment (checkout's lookup).
    index('platform_campaigns_running_idx')
      .on(t.starts_at, t.ends_at)
      .where(sql`${t.is_active}`),
    check('platform_campaigns_name_check', sql`btrim(${t.name}) <> ''`),
    check(
      'platform_campaigns_value_check',
      sql`${t.value} > 0 AND (${t.kind} <> 'PERCENTAGE' OR ${t.value} <= 100)`,
    ),
    check(
      'platform_campaigns_max_discount_check',
      sql`${t.max_discount_npr} IS NULL OR (${t.kind} = 'PERCENTAGE' AND ${t.max_discount_npr} > 0)`,
    ),
    check('platform_campaigns_min_cart_check', sql`${t.min_cart_npr} >= 0`),
    check(
      'platform_campaigns_vendor_share_check',
      sql`${t.vendor_share_percent} BETWEEN 0 AND 100`,
    ),
    check('platform_campaigns_dates_check', sql`${t.ends_at} > ${t.starts_at}`),
    check('platform_campaigns_terms_version_check', sql`${t.terms_version} >= 1`),
  ],
);

/**
 * Phase 26: a shop's own consent to a campaign (SPEC core 7). One ACTIVE row per campaign and
 * vendor. The triggers of migration 0024 refuse a row that the shop's own account did not create
 * (so no admin can enrol a shop), a row for a terms version that is not the campaign's current
 * one, any change but closing an ACTIVE row once, and every DELETE.
 */
export const campaignOptIns = pgTable(
  'campaign_opt_ins',
  {
    id: primaryId(),
    campaign_id: uuid()
      .notNull()
      .references(() => platformCampaigns.id, { onDelete: 'restrict' }),
    vendor_id: uuid()
      .notNull()
      .references(() => vendors.id, { onDelete: 'restrict' }),
    /** The campaign's `terms_version` the vendor was shown and agreed to. */
    opt_in_terms_version: integer().notNull(),
    /** The seven terms exactly as they were shown. */
    terms_snapshot: jsonb().$type<AuditState>().notNull(),
    status: campaignOptInStatusEnum().notNull().default('ACTIVE'),
    /** Always the vendor's own user. */
    opted_in_by_user_id: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    opted_in_at: timestamp({ withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    closed_at: timestamp({ withTimezone: true, mode: 'date' }),
    /** The vendor's own user for OPTED_OUT; null for VOIDED (the terms change has its own audit entry). */
    closed_by_user_id: uuid().references(() => users.id, { onDelete: 'restrict' }),
  },
  (t) => [
    uniqueIndex('campaign_opt_ins_active_uidx')
      .on(t.campaign_id, t.vendor_id)
      .where(sql`${t.status} = 'ACTIVE'`),
    // A campaign's live opt-in count; also serves the campaigns FK check.
    index('campaign_opt_ins_campaign_id_idx').on(t.campaign_id, t.status),
    index('campaign_opt_ins_vendor_id_idx').on(t.vendor_id, t.opted_in_at),
    index('campaign_opt_ins_opted_in_by_user_id_idx').on(t.opted_in_by_user_id),
    index('campaign_opt_ins_closed_by_user_id_idx')
      .on(t.closed_by_user_id)
      .where(sql`${t.closed_by_user_id} IS NOT NULL`),
    check('campaign_opt_ins_terms_version_check', sql`${t.opt_in_terms_version} >= 1`),
    check(
      'campaign_opt_ins_terms_snapshot_check',
      sql`jsonb_typeof(${t.terms_snapshot}) = 'object'`,
    ),
    check(
      'campaign_opt_ins_closed_check',
      sql`(${t.status} = 'ACTIVE') = (${t.closed_at} IS NULL)`,
    ),
    check(
      'campaign_opt_ins_closed_by_check',
      sql`(${t.status} = 'OPTED_OUT') = (${t.closed_by_user_id} IS NOT NULL)`,
    ),
  ],
);

/**
 * Phase 26: the Ad Marketplace price list (SPEC core 8). A price, not a charge: a vendor is
 * billed only through its own purchase. A published product's placement, billing model, price and
 * duration never change (a trigger of migration 0024 refuses it): a new price is a new product,
 * and the old one is taken off sale with `is_active`.
 */
export const adProducts = pgTable(
  'ad_products',
  {
    id: primaryId(),
    name: text().notNull(),
    slot: adSlotEnum().notNull(),
    billing_model: adBillingModelEnum().notNull(),
    /** NPR under both models: the price of the period, or the fixed fee per delivered order. */
    price_npr: npr().notNull(),
    duration_days: integer().notNull(),
    /** On sale in the Ad Marketplace. */
    is_active: boolean().notNull().default(true),
    created_by_user_id: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    created_at: createdAt(),
  },
  (t) => [
    index('ad_products_created_by_user_id_idx').on(t.created_by_user_id),
    check('ad_products_name_check', sql`btrim(${t.name}) <> ''`),
    check('ad_products_price_check', sql`${t.price_npr} > 0`),
    check('ad_products_duration_check', sql`${t.duration_days} BETWEEN 1 AND 90`),
  ],
);

/**
 * Phase 27: a vendor's own purchase of an ad product (SPEC core 8, "No unilateral billing"). It
 * is the only thing that can make a promotion sponsored or justify an ad charge, and it exists
 * only because the shop's own account agreed to it: a trigger of migration 0026 refuses a row
 * whose `agreed_by_user_id` is not the vendor's user.
 *
 * `billing_model` and `price_npr` are copies of the product's as agreed; `settlement_model` is
 * the shop's model at purchase, which decides how the charge is collected. `amount_paid_npr` is
 * what has been collected for it so far.
 *
 * Schema only: no route buys an ad yet, so the table is empty until the purchase flow is built.
 */
export const adPurchases = pgTable(
  'ad_purchases',
  {
    id: primaryId(),
    vendor_id: uuid()
      .notNull()
      .references(() => vendors.id, { onDelete: 'restrict' }),
    ad_product_id: uuid()
      .notNull()
      .references(() => adProducts.id, { onDelete: 'restrict' }),
    billing_model: adBillingModelEnum().notNull(),
    price_npr: npr().notNull(),
    /** PER_ORDER_PREMIUM only: the most the vendor will spend. */
    budget_npr: npr(),
    settlement_model: settlementModelEnum().notNull(),
    status: adPurchaseStatusEnum().notNull().default('ACTIVE'),
    starts_at: timestamp({ withTimezone: true, mode: 'date' }).notNull(),
    ends_at: timestamp({ withTimezone: true, mode: 'date' }).notNull(),
    amount_paid_npr: npr().notNull().default(0),
    /** Always the vendor's own user. */
    agreed_by_user_id: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    agreed_at: timestamp({ withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    /** One per purchase attempt: a retried request never buys twice. */
    idempotency_key: text().notNull(),
  },
  (t) => [
    uniqueIndex('ad_purchases_vendor_id_idempotency_key_uidx').on(t.vendor_id, t.idempotency_key),
    // A shop's running ads (the settlement model change guard, the sponsored feed).
    index('ad_purchases_vendor_id_status_idx').on(t.vendor_id, t.status),
    index('ad_purchases_ad_product_id_idx').on(t.ad_product_id, t.status),
    index('ad_purchases_agreed_by_user_id_idx').on(t.agreed_by_user_id),
    check('ad_purchases_price_check', sql`${t.price_npr} > 0`),
    check(
      'ad_purchases_budget_check',
      sql`(${t.billing_model} = 'PER_ORDER_PREMIUM') = (${t.budget_npr} IS NOT NULL) AND (${t.budget_npr} IS NULL OR ${t.budget_npr} >= ${t.price_npr})`,
    ),
    check('ad_purchases_dates_check', sql`${t.ends_at} > ${t.starts_at}`),
    check('ad_purchases_amount_paid_check', sql`${t.amount_paid_npr} >= 0`),
    check(
      'ad_purchases_idempotency_key_check',
      sql`char_length(${t.idempotency_key}) BETWEEN 8 AND 100`,
    ),
  ],
);

/**
 * Phase 32: a vendor's own offer (SPEC core 7, "Vendor Offers"). The vendor funds it entirely, so
 * the row exists only because the shop's own account created it: a trigger of migration 0034
 * refuses any other creator.
 *
 * A rule is never edited. The same trigger lets an UPDATE set `ended_at` / `ended_by_user_id`
 * once and nothing else, and refuses DELETE: changing an offer ends this row and creates another,
 * so an order always points at the exact rule it was priced with.
 *
 * There is no status column: "ended" (its `ends_at` passed) is read from the clock and "cancelled"
 * from `ended_at`, so nothing stored goes stale (`vendorOfferStatusOf` in shared-types).
 */
export const vendorOffers = pgTable(
  'vendor_offers',
  {
    id: primaryId(),
    vendor_id: uuid()
      .notNull()
      .references(() => vendors.id, { onDelete: 'restrict' }),
    kind: discountKindEnum().notNull(),
    /** NPR for FLAT; percent for PERCENTAGE. */
    value: numeric({ precision: 12, scale: 2, mode: 'number' }).notNull(),
    /** The most one order is discounted; PERCENTAGE only. */
    max_discount_npr: npr(),
    min_cart_npr: npr().notNull().default(0),
    /** "Flat Rs. 200 OFF": rendered by the server from the rule at creation. */
    label: text().notNull(),
    starts_at: timestamp({ withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    /** Null: until the shop ends it. */
    ends_at: timestamp({ withTimezone: true, mode: 'date' }),
    /** Always the vendor's own user. */
    created_by_user_id: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    created_at: createdAt(),
    /** The shop switched it off. Set once, never cleared. */
    ended_at: timestamp({ withTimezone: true, mode: 'date' }),
    ended_by_user_id: uuid().references(() => users.id, { onDelete: 'restrict' }),
  },
  (t) => [
    // A shop's offers newest first; also serves the vendors FK check.
    index('vendor_offers_vendor_id_idx').on(t.vendor_id, t.created_at),
    // The offers that can still apply to an order (checkout's lookup).
    index('vendor_offers_live_idx')
      .on(t.vendor_id, t.starts_at)
      .where(sql`${t.ended_at} IS NULL`),
    index('vendor_offers_created_by_user_id_idx').on(t.created_by_user_id),
    index('vendor_offers_ended_by_user_id_idx')
      .on(t.ended_by_user_id)
      .where(sql`${t.ended_by_user_id} IS NOT NULL`),
    check(
      'vendor_offers_value_check',
      sql`${t.value} > 0 AND (${t.kind} <> 'PERCENTAGE' OR ${t.value} <= 100)`,
    ),
    check(
      'vendor_offers_max_discount_check',
      sql`${t.max_discount_npr} IS NULL OR (${t.kind} = 'PERCENTAGE' AND ${t.max_discount_npr} > 0)`,
    ),
    check('vendor_offers_min_cart_check', sql`${t.min_cart_npr} >= 0`),
    // A flat offer never exceeds its own minimum cart.
    check(
      'vendor_offers_flat_min_cart_check',
      sql`${t.kind} <> 'FLAT' OR ${t.min_cart_npr} >= ${t.value}`,
    ),
    check('vendor_offers_label_check', sql`btrim(${t.label}) <> ''`),
    check('vendor_offers_dates_check', sql`${t.ends_at} IS NULL OR ${t.ends_at} > ${t.starts_at}`),
    check(
      'vendor_offers_ended_check',
      sql`(${t.ended_at} IS NULL) = (${t.ended_by_user_id} IS NULL)`,
    ),
  ],
);
