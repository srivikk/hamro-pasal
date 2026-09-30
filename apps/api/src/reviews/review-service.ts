import { orders, reviews, vendors, type Database } from '@hamro-pasal/db';
import {
  POST_DELIVERY_WINDOW_HOURS,
  type Order,
  type Review,
  type ReviewDirection,
} from '@hamro-pasal/shared-types';
import { and, eq, ne, sql } from 'drizzle-orm';

import { OrderNotFoundError } from '../checkout/checkout-service';
import { reviewIsPublic } from './review-visibility';

/** Only a DELIVERED order can be reviewed (SPEC customer journey 11). */
export class OrderNotReviewableError extends Error {
  constructor(
    readonly orderId: string,
    readonly state: Order['state'],
  ) {
    super(`Order ${orderId} cannot be reviewed in state ${state}`);
    this.name = 'OrderNotReviewableError';
  }
}

/**
 * The 48 h post-delivery window has closed. Accepting a late review would break the double blind:
 * by then the other side's review is already public.
 */
export class ReviewWindowClosedError extends Error {
  constructor(readonly orderId: string) {
    super(
      `Order ${orderId} can no longer be reviewed: the ${String(POST_DELIVERY_WINDOW_HOURS)} h window has closed`,
    );
    this.name = 'ReviewWindowClosedError';
  }
}

/** Each side reviews an order once. */
export class ReviewAlreadySubmittedError extends Error {
  constructor(
    readonly orderId: string,
    readonly reviewId: string,
  ) {
    super(`Order ${orderId} has already been reviewed`);
    this.name = 'ReviewAlreadySubmittedError';
  }
}

export interface ReviewSubmissionInput {
  readonly orderId: string;
  /** CUSTOMER_TO_VENDOR: the order's customer. VENDOR_TO_CUSTOMER: the vendor's own user. */
  readonly direction: ReviewDirection;
  readonly authorUserId: string;
  readonly rating: number;
  readonly feedback: string | null;
}

const COUNTERPART: Record<ReviewDirection, ReviewDirection> = {
  CUSTOMER_TO_VENDOR: 'VENDOR_TO_CUSTOMER',
  VENDOR_TO_CUSTOMER: 'CUSTOMER_TO_VENDOR',
};

/**
 * Double-blind reviews (SPEC §6). A review is stored quarantined (`is_published = false`) and
 * becomes public when the other side has reviewed the same order too (both are then published in
 * the same transaction), or when 48 hours have passed since `orders.delivered_at` (`reviewIsPublic`).
 */
export class ReviewService {
  constructor(private readonly db: Database) {}

  /**
   * Stores one side's review. In one transaction, under SELECT ... FOR UPDATE on the order (so the
   * customer's and the vendor's submissions are serialised and the second one always sees the
   * first):
   *   - the author must be the order's customer (or the vendor's user): anyone else gets 404;
   *   - the order must be DELIVERED (409 otherwise);
   *   - the 48 h window from delivered_at must still be open, on the database clock (422);
   *   - one review per side (409, with the existing review's id);
   *   - if the other side has already reviewed, both are published now; otherwise it is quarantined.
   */
  async submit(input: ReviewSubmissionInput): Promise<Review> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .select({
          order: orders,
          vendorUserId: vendors.user_id,
          windowOpen:
            sql<boolean>`${orders.delivered_at} IS NOT NULL AND clock_timestamp() < ${orders.delivered_at} + make_interval(hours => ${POST_DELIVERY_WINDOW_HOURS})`.mapWith(
              Boolean,
            ),
        })
        .from(orders)
        .innerJoin(vendors, eq(vendors.id, orders.vendor_id))
        .where(eq(orders.id, input.orderId))
        .for('update', { of: orders });

      const author =
        input.direction === 'CUSTOMER_TO_VENDOR' ? row?.order.customer_id : row?.vendorUserId;
      if (row === undefined || author !== input.authorUserId) {
        throw new OrderNotFoundError(input.orderId);
      }
      if (row.order.state !== 'DELIVERED') {
        throw new OrderNotReviewableError(input.orderId, row.order.state);
      }
      if (!row.windowOpen) {
        throw new ReviewWindowClosedError(input.orderId);
      }

      const existing = await tx
        .select({ id: reviews.id, direction: reviews.direction })
        .from(reviews)
        .where(eq(reviews.order_id, input.orderId));
      const own = existing.find((review) => review.direction === input.direction);
      if (own !== undefined) {
        throw new ReviewAlreadySubmittedError(input.orderId, own.id);
      }
      const bothSides = existing.some(
        (review) => review.direction === COUNTERPART[input.direction],
      );

      const [review] = await tx
        .insert(reviews)
        .values({
          order_id: input.orderId,
          direction: input.direction,
          rating: input.rating,
          comment: input.feedback,
          ...(bothSides ? { is_published: true, published_at: sql`now()` } : {}),
        })
        .returning();
      if (review === undefined) throw new Error(`Review for order ${input.orderId} not stored`);

      if (bothSides) {
        // The other side's review leaves quarantine at the same instant (same now()).
        await tx
          .update(reviews)
          .set({ is_published: true, published_at: sql`now()` })
          .where(
            and(
              eq(reviews.order_id, input.orderId),
              ne(reviews.id, review.id),
              eq(reviews.is_published, false),
            ),
          );
      }
      return review;
    });
  }

  /**
   * One side's review of an order as others may see it (SPEC verification test 4): null while it
   * is quarantined (missing, or only one side reviewed and less than 48 h since delivery).
   */
  async publicReview(orderId: string, direction: ReviewDirection): Promise<Review | null> {
    const [row] = await this.db
      .select({ review: reviews })
      .from(reviews)
      .innerJoin(orders, eq(orders.id, reviews.order_id))
      .where(
        and(eq(reviews.order_id, orderId), eq(reviews.direction, direction), reviewIsPublic()),
      );
    return row?.review ?? null;
  }
}
