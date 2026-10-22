import { z } from 'zod';

/*
 * 2026-10-21 (Task 5): verified-purchase product reviews. Only a customer whose delivered order
 * held the product may review it, once per product (a second review replaces the first). Unlike
 * the order reviews of SPEC core 6 (double-blind, both directions) a product review is one-way and
 * is published at once. Reviewers are shown by first name only (SPEC implicit requirement 6).
 */

export const MAX_PRODUCT_REVIEW_COMMENT_LENGTH = 500;
export const PRODUCT_REVIEW_PAGE_LIMIT = 20;

/** POST /api/products/:id/reviews (CUSTOMER). */
export const productReviewRequestSchema = z.strictObject({
  rating: z.number().int().min(1).max(5),
  comment: z
    .string()
    .trim()
    .max(MAX_PRODUCT_REVIEW_COMMENT_LENGTH)
    .nullish()
    .transform((value) => (value === undefined || value === null || value === '' ? null : value)),
});
export type ProductReviewRequest = z.input<typeof productReviewRequestSchema>;

export const productReviewViewSchema = z.strictObject({
  id: z.uuid(),
  product_id: z.uuid(),
  rating: z.number().int().min(1).max(5),
  comment: z.string().nullable(),
  /** First name only; null when the reviewer has none on record. */
  reviewer_first_name: z.string().nullable(),
  /** Always true: no other review is accepted. Kept so the app can label it. */
  verified_purchase: z.literal(true),
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime(),
});
export type ProductReviewView = z.infer<typeof productReviewViewSchema>;

export const productRatingSummarySchema = z.strictObject({
  /** 1 to 5 with one decimal; null before the first review. */
  average: z.number().min(1).max(5).nullable(),
  count: z.number().int().nonnegative(),
});
export type ProductRatingSummary = z.infer<typeof productRatingSummarySchema>;

/** GET /api/products/:id/reviews?cursor=: newest first, with the product's summary. */
export const productReviewListQuerySchema = z.strictObject({
  cursor: z.uuid().optional(),
});

export const productReviewListResponseSchema = z.strictObject({
  summary: productRatingSummarySchema,
  reviews: z.array(productReviewViewSchema),
  next_cursor: z.uuid().nullable(),
  /** The signed-in customer: whether a delivered order lets them review, and their own review. */
  viewer: z
    .strictObject({
      can_review: z.boolean(),
      own_review: productReviewViewSchema.nullable(),
    })
    .nullable(),
});
export type ProductReviewListResponseBody = z.infer<typeof productReviewListResponseSchema>;

export const productReviewResponseSchema = z.strictObject({ review: productReviewViewSchema });
export type ProductReviewResponseBody = z.infer<typeof productReviewResponseSchema>;
