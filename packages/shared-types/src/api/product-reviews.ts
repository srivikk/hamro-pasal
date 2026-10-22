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
      /**
       * 2026-10-22 (Task 6): Hamro Pasal unpublished the customer's own review (it is then in
       * neither the list nor the average). Defaults to false for an API from before the field.
       */
      own_review_hidden: z.boolean().default(false),
    })
    .nullable(),
});
export type ProductReviewListResponseBody = z.infer<typeof productReviewListResponseSchema>;

export const productReviewResponseSchema = z.strictObject({ review: productReviewViewSchema });
export type ProductReviewResponseBody = z.infer<typeof productReviewResponseSchema>;

/*
 * 2026-10-22 (Task 6): Super Admin moderation. A review that breaks platform policy is unpublished
 * with a written reason (audited) and can be published again. A hidden review stays hidden when its
 * author edits it.
 */

export const PRODUCT_REVIEW_HIDE_REASON_MIN_LENGTH = 10;
export const PRODUCT_REVIEW_HIDE_REASON_MAX_LENGTH = 300;
export const ADMIN_PRODUCT_REVIEW_DEFAULT_LIMIT = 50;

/** GET /api/admin/product-reviews?status=&cursor=&limit=: newest first. */
export const adminProductReviewListQuerySchema = z.strictObject({
  status: z.enum(['VISIBLE', 'HIDDEN']).optional(),
  cursor: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(ADMIN_PRODUCT_REVIEW_DEFAULT_LIMIT),
});
export type AdminProductReviewListQuery = z.infer<typeof adminProductReviewListQuerySchema>;

export const adminProductReviewViewSchema = z.strictObject({
  ...productReviewViewSchema.shape,
  product_name: z.string(),
  vendor: z.strictObject({ id: z.uuid(), business_name: z.string() }),
  hidden: z.boolean(),
  hidden_at: z.iso.datetime().nullable(),
  hidden_reason: z.string().nullable(),
});
export type AdminProductReviewView = z.infer<typeof adminProductReviewViewSchema>;

export const adminProductReviewListResponseSchema = z.strictObject({
  reviews: z.array(adminProductReviewViewSchema),
  next_cursor: z.uuid().nullable(),
});
export type AdminProductReviewListResponseBody = z.infer<
  typeof adminProductReviewListResponseSchema
>;

/** PATCH /api/admin/product-reviews/:id: hide with a reason, or show again. */
export const adminProductReviewModerationRequestSchema = z.discriminatedUnion('hidden', [
  z.strictObject({
    hidden: z.literal(true),
    reason: z
      .string()
      .trim()
      .min(PRODUCT_REVIEW_HIDE_REASON_MIN_LENGTH)
      .max(PRODUCT_REVIEW_HIDE_REASON_MAX_LENGTH),
  }),
  z.strictObject({ hidden: z.literal(false) }),
]);
export type AdminProductReviewModerationRequest = z.input<
  typeof adminProductReviewModerationRequestSchema
>;

export const adminProductReviewResponseSchema = z.strictObject({
  review: adminProductReviewViewSchema,
});
export type AdminProductReviewResponseBody = z.infer<typeof adminProductReviewResponseSchema>;
