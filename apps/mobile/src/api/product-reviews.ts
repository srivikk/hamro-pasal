import {
  productReviewListResponseSchema,
  productReviewRequestSchema,
  productReviewResponseSchema,
  type ProductReviewListResponseBody,
  type ProductReviewRequest,
  type ProductReviewView,
} from '@hamro-pasal/shared-types';

import { ApiError, apiRequest } from './http';

export const productReviewsPath = (productId: string): string =>
  `/api/products/${productId}/reviews`;

/** Server codes the review form branches on (SPEC core 6, "Ratings and product reviews"). */
export const PRODUCT_REVIEW_ERROR_CODES = {
  /** 403: no delivered order of this customer held the product. */
  notVerified: 'NOT_A_VERIFIED_PURCHASE',
  /** Client-side: the input broke the request contract; nothing was sent. */
  invalid: 'INVALID_PRODUCT_REVIEW',
} as const;

/**
 * GET /api/products/:id/reviews?cursor=: the product's summary and a page of its newest reviews.
 * Public; a signed-in customer's token is sent when one is in memory, so the answer also says
 * whether they may review.
 */
export function fetchProductReviews(
  productId: string,
  cursor?: string,
): Promise<ProductReviewListResponseBody> {
  return apiRequest({
    method: 'GET',
    path: productReviewsPath(productId),
    ...(cursor === undefined ? {} : { query: { cursor } }),
    authenticated: 'optional',
    schema: productReviewListResponseSchema,
  });
}

/** POST /api/products/:id/reviews: a verified purchase only; a second review replaces the first. */
export async function submitProductReview(
  productId: string,
  input: ProductReviewRequest,
): Promise<ProductReviewView> {
  const body = productReviewRequestSchema.safeParse(input);
  if (!body.success) {
    throw new ApiError(400, PRODUCT_REVIEW_ERROR_CODES.invalid, body.error.message);
  }
  const { review } = await apiRequest({
    method: 'POST',
    path: productReviewsPath(productId),
    body: body.data,
    schema: productReviewResponseSchema,
  });
  return review;
}
