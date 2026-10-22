import { MAX_PRODUCT_REVIEW_COMMENT_LENGTH } from '@hamro-pasal/shared-types';
import { sql } from 'drizzle-orm';
import {
  check,
  index,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

import { createdAt, primaryId, updatedAt } from './columns';
import { orders } from './orders';
import { users } from './users';
import { products } from './vendors';

/**
 * 2026-10-21 (Task 5): verified-purchase product reviews. One per customer and product (a new
 * review replaces it); `order_id` is the delivered order that made it a verified purchase.
 * Published at once: one-way, unlike the double-blind order reviews of `reviews`.
 */
export const productReviews = pgTable(
  'product_reviews',
  {
    id: primaryId(),
    product_id: uuid()
      .notNull()
      .references(() => products.id, { onDelete: 'restrict' }),
    customer_id: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    order_id: uuid()
      .notNull()
      .references(() => orders.id, { onDelete: 'restrict' }),
    rating: smallint().notNull(),
    comment: text(),
    /**
     * 2026-10-22 (Task 6): a Super Admin unpublished the review (platform policy). Hidden reviews
     * leave the public list and the product's average; the three columns are set together.
     */
    hidden_at: timestamp({ withTimezone: true }),
    hidden_by_user_id: uuid().references(() => users.id, { onDelete: 'restrict' }),
    hidden_reason: text(),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (t) => [
    unique('product_reviews_product_id_customer_id_key').on(t.product_id, t.customer_id),
    index('product_reviews_product_id_created_at_idx').on(t.product_id, t.created_at, t.id),
    // 2026-10-22: the foreign keys' own indexes (the Phase 23 audit).
    index('product_reviews_customer_id_idx').on(t.customer_id),
    index('product_reviews_order_id_idx').on(t.order_id),
    index('product_reviews_hidden_by_user_id_idx')
      .on(t.hidden_by_user_id)
      .where(sql`${t.hidden_by_user_id} IS NOT NULL`),
    check(
      'product_reviews_hidden_check',
      sql`(${t.hidden_at} IS NULL) = (${t.hidden_by_user_id} IS NULL) AND (${t.hidden_at} IS NULL) = (${t.hidden_reason} IS NULL) AND (${t.hidden_reason} IS NULL OR btrim(${t.hidden_reason}) <> '')`,
    ),
    check('product_reviews_rating_check', sql`${t.rating} BETWEEN 1 AND 5`),
    check(
      'product_reviews_comment_check',
      sql.raw(
        `comment IS NULL OR (btrim(comment) <> '' AND char_length(comment) <= ${String(MAX_PRODUCT_REVIEW_COMMENT_LENGTH)})`,
      ),
    ),
  ],
);
