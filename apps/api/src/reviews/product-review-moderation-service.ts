import {
  productReviews,
  products,
  recordAuditLog,
  users,
  vendors,
  type Database,
} from '@hamro-pasal/db';
import {
  NO_AUDIT_CONTEXT,
  type AdminProductReviewListQuery,
  type AdminProductReviewModerationRequest,
  type AdminProductReviewView,
  type AuditContext,
} from '@hamro-pasal/shared-types';
import { adminProductReviewModerationRequestSchema } from '@hamro-pasal/shared-types';
import { and, desc, eq, isNotNull, isNull, sql } from 'drizzle-orm';

import { HttpError } from '../http/http-error';

export interface AdminProductReviewPage {
  readonly reviews: readonly AdminProductReviewView[];
  readonly nextCursor: string | null;
}

type ReviewRow = typeof productReviews.$inferSelect;

interface Joined {
  readonly review: ReviewRow;
  readonly firstName: string | null;
  readonly productName: string;
  readonly vendorId: string;
  readonly businessName: string;
}

function adminView(row: Joined): AdminProductReviewView {
  const { review } = row;
  return {
    id: review.id,
    product_id: review.product_id,
    rating: review.rating,
    comment: review.comment,
    reviewer_first_name: row.firstName,
    verified_purchase: true,
    created_at: review.created_at.toISOString(),
    updated_at: review.updated_at.toISOString(),
    product_name: row.productName,
    vendor: { id: row.vendorId, business_name: row.businessName },
    hidden: review.hidden_at !== null,
    hidden_at: review.hidden_at?.toISOString() ?? null,
    hidden_reason: review.hidden_reason,
  };
}

/**
 * 2026-10-22 (Task 6): Super Admin moderation of product reviews.
 *
 * - `list`: every review (any product, hidden ones included), newest first, filterable by state.
 * - `moderate`: hides a review with a written reason, or shows it again. One transaction under the
 *   review's row lock with its audit entry (`PRODUCT_REVIEW_HIDDEN` / `PRODUCT_REVIEW_SHOWN`);
 *   asking for the state it already has changes and records nothing. A hidden review leaves the
 *   public list and the product's average, and stays hidden when its author edits it.
 */
export class ProductReviewModerationService {
  constructor(private readonly db: Database) {}

  private select() {
    return this.db
      .select({
        review: productReviews,
        firstName: users.first_name,
        productName: products.name,
        vendorId: vendors.id,
        businessName: vendors.business_name,
      })
      .from(productReviews)
      .innerJoin(users, eq(users.id, productReviews.customer_id))
      .innerJoin(products, eq(products.id, productReviews.product_id))
      .innerJoin(vendors, eq(vendors.id, products.vendor_id));
  }

  async list({
    status,
    cursor,
    limit,
  }: AdminProductReviewListQuery): Promise<AdminProductReviewPage> {
    if (cursor !== undefined) {
      const [known] = await this.db
        .select({ id: productReviews.id })
        .from(productReviews)
        .where(eq(productReviews.id, cursor));
      if (known === undefined) throw new HttpError(400, 'INVALID_CURSOR', 'Unknown cursor');
    }
    const rows = await this.select()
      .where(
        and(
          status === 'HIDDEN'
            ? isNotNull(productReviews.hidden_at)
            : status === 'VISIBLE'
              ? isNull(productReviews.hidden_at)
              : undefined,
          cursor === undefined
            ? undefined
            : sql`(${productReviews.created_at}, ${productReviews.id}) <
                (SELECT c.created_at, c.id FROM product_reviews c WHERE c.id = ${cursor})`,
        ),
      )
      .orderBy(desc(productReviews.created_at), desc(productReviews.id))
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    return {
      reviews: page.map(adminView),
      nextCursor: rows.length > limit ? (page.at(-1)?.review.id ?? null) : null,
    };
  }

  async moderate(
    adminUserId: string,
    reviewId: string,
    request: AdminProductReviewModerationRequest,
    context: AuditContext = NO_AUDIT_CONTEXT,
  ): Promise<AdminProductReviewView> {
    const input = adminProductReviewModerationRequestSchema.parse(request);
    await this.db.transaction(async (tx) => {
      const [before] = await tx
        .select()
        .from(productReviews)
        .where(eq(productReviews.id, reviewId))
        .for('update');
      if (before === undefined) {
        throw new HttpError(404, 'PRODUCT_REVIEW_NOT_FOUND', `Review ${reviewId} not found`);
      }
      const wasHidden = before.hidden_at !== null;
      if (wasHidden === input.hidden) return;

      const [after] = await tx
        .update(productReviews)
        .set(
          input.hidden
            ? { hidden_at: sql`now()`, hidden_by_user_id: adminUserId, hidden_reason: input.reason }
            : { hidden_at: null, hidden_by_user_id: null, hidden_reason: null },
        )
        .where(eq(productReviews.id, reviewId))
        .returning();
      if (after === undefined) throw new Error('Product review was not updated');

      const [owner] = await tx
        .select({ vendorId: products.vendor_id })
        .from(products)
        .where(eq(products.id, before.product_id));
      await recordAuditLog(tx, {
        actor: { kind: 'USER', user_id: adminUserId, role: 'SUPER_ADMIN' },
        action: input.hidden ? 'PRODUCT_REVIEW_HIDDEN' : 'PRODUCT_REVIEW_SHOWN',
        entityId: reviewId,
        vendorId: owner?.vendorId ?? null,
        beforeState: { hidden: wasHidden, hidden_reason: before.hidden_reason },
        afterState: { hidden: input.hidden, hidden_reason: after.hidden_reason },
        context,
      });
    });

    const [row] = await this.select().where(eq(productReviews.id, reviewId));
    if (row === undefined) throw new Error('Product review vanished');
    return adminView(row);
  }
}
