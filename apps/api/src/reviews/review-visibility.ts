import { orders, reviews } from '@hamro-pasal/db';
import { POST_DELIVERY_WINDOW_HOURS } from '@hamro-pasal/shared-types';
import { sql, type SQL } from 'drizzle-orm';

/**
 * SQL condition: the review may be shown and counted (SPEC §6). A review is public once
 * `is_published` is set (both sides reviewed), or once 48 hours have passed since the order's
 * delivery, whether or not anything has flipped the flag yet. Needs `orders` joined on
 * `reviews.order_id`.
 */
export function reviewIsPublic(): SQL<boolean> {
  return sql<boolean>`(${reviews.is_published} OR (${orders.delivered_at} IS NOT NULL AND ${orders.delivered_at} <= now() - make_interval(hours => ${POST_DELIVERY_WINDOW_HOURS})))`;
}
