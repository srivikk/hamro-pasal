import { promotionPlacements, promotionTargetTypes } from '@hamro-pasal/shared-types';
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

import { createdAt, primaryId, updatedAt } from './columns';
import { adPurchases } from './marketing';
import { users } from './users';

export const promotionPlacementEnum = pgEnum('promotion_placement', promotionPlacements);
export const promotionTargetTypeEnum = pgEnum('promotion_target_type', promotionTargetTypes);

/**
 * Phase 26: the Home screen's banners and Featured Offers tiles (STATE_HANDOFF §8Z.4). A
 * promotion navigates or filters; it never changes a price.
 *
 * `target_value` is text for all three target types (a vendor id, a category slug, an offer
 * label), so no foreign key guards it: the write validates it and the public read drops a
 * promotion whose target is gone.
 *
 * A promotion is sponsored exactly when it names an ad purchase (SPEC core 8), and the foreign
 * key (migration 0026) refuses a purchase that does not exist: the database cannot hold an ad
 * nobody bought.
 */
export const homePromotions = pgTable(
  'home_promotions',
  {
    id: primaryId(),
    placement: promotionPlacementEnum().notNull(),
    image_url: text(),
    title: text(),
    subtitle: text(),
    target_type: promotionTargetTypeEnum(),
    target_value: text(),
    display_order: integer().notNull().default(0),
    is_active: boolean().notNull().default(true),
    /** Null: from now. */
    starts_at: timestamp({ withTimezone: true, mode: 'date' }),
    /** Null: until it is switched off. */
    ends_at: timestamp({ withTimezone: true, mode: 'date' }),
    is_sponsored: boolean().notNull().default(false),
    ad_purchase_id: uuid().references(() => adPurchases.id, { onDelete: 'restrict' }),
    created_by_user_id: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (t) => [
    index('home_promotions_listing_idx').on(t.placement, t.is_active, t.display_order),
    index('home_promotions_created_by_user_id_idx').on(t.created_by_user_id),
    index('home_promotions_ad_purchase_id_idx')
      .on(t.ad_purchase_id)
      .where(sql`${t.ad_purchase_id} IS NOT NULL`),
    check('home_promotions_display_order_check', sql`${t.display_order} >= 0`),
    // A banner is its artwork; an offer tile needs its text.
    check(
      'home_promotions_image_check',
      sql`${t.placement} <> 'CAROUSEL' OR ${t.image_url} IS NOT NULL`,
    ),
    check(
      'home_promotions_title_check',
      sql`${t.placement} <> 'FEATURED' OR ${t.title} IS NOT NULL`,
    ),
    check(
      'home_promotions_text_check',
      sql`(${t.title} IS NULL OR btrim(${t.title}) <> '') AND (${t.subtitle} IS NULL OR btrim(${t.subtitle}) <> '')`,
    ),
    check(
      'home_promotions_target_check',
      sql`(${t.target_type} IS NULL) = (${t.target_value} IS NULL) AND (${t.target_value} IS NULL OR btrim(${t.target_value}) <> '')`,
    ),
    check(
      'home_promotions_dates_check',
      sql`${t.starts_at} IS NULL OR ${t.ends_at} IS NULL OR ${t.starts_at} < ${t.ends_at}`,
    ),
    check(
      'home_promotions_sponsored_check',
      sql`${t.is_sponsored} = (${t.ad_purchase_id} IS NOT NULL)`,
    ),
  ],
);
