import { MAX_PRODUCT_REVIEW_COMMENT_LENGTH } from '@hamro-pasal/shared-types';
import { sql } from 'drizzle-orm';
import { check, index, pgTable, smallint, text, unique, uuid } from 'drizzle-orm/pg-core';

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
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (t) => [
    unique('product_reviews_product_id_customer_id_key').on(t.product_id, t.customer_id),
    index('product_reviews_product_id_created_at_idx').on(t.product_id, t.created_at, t.id),
    check('product_reviews_rating_check', sql`${t.rating} BETWEEN 1 AND 5`),
    check(
      'product_reviews_comment_check',
      sql.raw(
        `comment IS NULL OR (btrim(comment) <> '' AND char_length(comment) <= ${String(MAX_PRODUCT_REVIEW_COMMENT_LENGTH)})`,
      ),
    ),
  ],
);
