import {
  orderItems,
  orders,
  productListed,
  productReviews,
  products,
  users,
  type Database,
} from '@hamro-pasal/db';
import type {
  ProductRatingSummary,
  ProductReviewView,
  ProductReviewRequest,
} from '@hamro-pasal/shared-types';
import { PRODUCT_REVIEW_PAGE_LIMIT, productReviewRequestSchema } from '@hamro-pasal/shared-types';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';

import { HttpError } from '../http/http-error';

type ReviewRow = typeof productReviews.$inferSelect;

export interface ProductReviewPage {
  readonly summary: ProductRatingSummary;
  readonly reviews: readonly ProductReviewView[];
  readonly nextCursor: string | null;
  readonly viewer: {
    readonly canReview: boolean;
    readonly ownReview: ProductReviewView | null;
    /** 2026-10-22 (Task 6): Hamro Pasal unpublished the viewer's own review. */
    readonly ownReviewHidden: boolean;
  } | null;
}

/** Orders that make a purchase verified: delivered, and still so while disputed. */
const DELIVERED_STATES = ['DELIVERED', 'DISPUTED'] as const;

function view(row: ReviewRow, firstName: string | null): ProductReviewView {
  return {
    id: row.id,
    product_id: row.product_id,
    rating: row.rating,
    comment: row.comment,
    reviewer_first_name: firstName,
    verified_purchase: true,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

/**
 * 2026-10-21 (Task 5): verified-purchase product reviews.
 *
 * - `upsert`: a customer whose delivered order held the product rates it (1 to 5, an optional
 *   comment); a second review replaces the first. Anyone else: 403 NOT_A_VERIFIED_PURCHASE.
 * - `list`: newest first, with the product's average and count, and for a signed-in customer
 *   whether they may review it and their own review.
 * Only products customers can see are reviewed or listed (hidden or removed ones are 404).
 */
export class ProductReviewService {
  constructor(private readonly db: Database) {}

  private async assertListed(productId: string): Promise<void> {
    const [product] = await this.db
      .select({ id: products.id })
      .from(products)
      .where(and(eq(products.id, productId), productListed()));
    if (product === undefined) {
      throw new HttpError(404, 'PRODUCT_NOT_FOUND', `Product ${productId} not found`);
    }
  }

  /** The customer's latest delivered order holding the product, or null. */
  private async verifyingOrder(customerId: string, productId: string): Promise<string | null> {
    const [order] = await this.db
      .select({ id: orders.id })
      .from(orders)
      .innerJoin(orderItems, eq(orderItems.order_id, orders.id))
      .where(
        and(
          eq(orders.customer_id, customerId),
          eq(orderItems.product_id, productId),
          inArray(orders.state, [...DELIVERED_STATES]),
        ),
      )
      .orderBy(desc(orders.delivered_at), desc(orders.id))
      .limit(1);
    return order?.id ?? null;
  }

  private async firstNameOf(userId: string): Promise<string | null> {
    const [user] = await this.db
      .select({ firstName: users.first_name })
      .from(users)
      .where(eq(users.id, userId));
    return user?.firstName ?? null;
  }

  async upsert(
    customerId: string,
    productId: string,
    request: ProductReviewRequest,
  ): Promise<ProductReviewView> {
    const input = productReviewRequestSchema.parse(request);
    await this.assertListed(productId);
    const orderId = await this.verifyingOrder(customerId, productId);
    if (orderId === null) {
      throw new HttpError(
        403,
        'NOT_A_VERIFIED_PURCHASE',
        'Only a customer who received this product in a delivered order can review it',
      );
    }
    const [row] = await this.db
      .insert(productReviews)
      .values({
        product_id: productId,
        customer_id: customerId,
        order_id: orderId,
        rating: input.rating,
        comment: input.comment,
      })
      .onConflictDoUpdate({
        target: [productReviews.product_id, productReviews.customer_id],
        set: { rating: input.rating, comment: input.comment, order_id: orderId },
      })
      .returning();
    if (row === undefined) throw new Error('Product review was not stored');
    return view(row, await this.firstNameOf(customerId));
  }

  async list(
    productId: string,
    cursor: string | undefined,
    viewerId: string | null,
  ): Promise<ProductReviewPage> {
    await this.assertListed(productId);
    const [summary] = await this.db
      .select({
        average: sql<number | null>`round(avg(${productReviews.rating})::numeric, 1)`.mapWith(
          (value: unknown) => (value === null ? null : Number(value)),
        ),
        count: sql<number>`count(*)::int`.mapWith(Number),
      })
      .from(productReviews)
      .where(and(eq(productReviews.product_id, productId), isNull(productReviews.hidden_at)));

    const rows = await this.db
      .select({ review: productReviews, firstName: users.first_name })
      .from(productReviews)
      .innerJoin(users, eq(users.id, productReviews.customer_id))
      .where(
        and(
          eq(productReviews.product_id, productId),
          isNull(productReviews.hidden_at),
          cursor === undefined
            ? undefined
            : sql`(${productReviews.created_at}, ${productReviews.id}) <
                (SELECT c.created_at, c.id FROM product_reviews c WHERE c.id = ${cursor})`,
        ),
      )
      .orderBy(desc(productReviews.created_at), desc(productReviews.id))
      .limit(PRODUCT_REVIEW_PAGE_LIMIT + 1);
    const page = rows.slice(0, PRODUCT_REVIEW_PAGE_LIMIT);

    let viewer: ProductReviewPage['viewer'] = null;
    if (viewerId !== null) {
      const [own] = await this.db
        .select()
        .from(productReviews)
        .where(
          and(eq(productReviews.product_id, productId), eq(productReviews.customer_id, viewerId)),
        );
      viewer = {
        canReview: (await this.verifyingOrder(viewerId, productId)) !== null,
        ownReview: own === undefined ? null : view(own, await this.firstNameOf(viewerId)),
        ownReviewHidden: own?.hidden_at != null,
      };
    }

    return {
      summary: { average: summary?.average ?? null, count: summary?.count ?? 0 },
      reviews: page.map((row) => view(row.review, row.firstName)),
      nextCursor: rows.length > PRODUCT_REVIEW_PAGE_LIMIT ? (page.at(-1)?.review.id ?? null) : null,
      viewer,
    };
  }
}
