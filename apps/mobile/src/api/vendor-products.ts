import {
  PRODUCT_LIST_MAX_LIMIT,
  vendorProductCreateRequestSchema,
  vendorProductListResponseSchema,
  vendorProductResponseSchema,
  vendorProductUpdateRequestSchema,
  type VendorProductListResponseBody,
  type VendorProductView,
} from '@hamro-pasal/shared-types';
import { z } from 'zod';

import { ApiError, apiRequest } from './http';

export const VENDOR_PRODUCTS_PATH = '/api/vendor/products';

/** Server codes the Catalogue words itself. */
export const PRODUCT_ERROR_CODES = {
  nameTaken: 'PRODUCT_NAME_TAKEN',
  categoryUnavailable: 'CATEGORY_UNAVAILABLE',
  notFound: 'PRODUCT_NOT_FOUND',
  /** Client side: the product broke the contract and was not sent. */
  invalid: 'INVALID_PRODUCT',
} as const;

/** What the product form produces (the fields the vendor edits). */
export interface ProductDraft {
  categoryId: string;
  name: string;
  priceNpr: number;
  stockQuantity: number;
}

/** GET /api/vendor/products: one page of the shop's own products, hidden ones included, by name. */
export function fetchOwnProducts(cursor: string | null): Promise<VendorProductListResponseBody> {
  return apiRequest({
    method: 'GET',
    path: VENDOR_PRODUCTS_PATH,
    query: {
      limit: String(PRODUCT_LIST_MAX_LIMIT),
      ...(cursor === null ? {} : { cursor }),
    },
    schema: vendorProductListResponseSchema,
  });
}

function checked<T>(schema: z.ZodType<T>, value: unknown): T {
  const body = schema.safeParse(value);
  if (!body.success) throw new ApiError(400, PRODUCT_ERROR_CODES.invalid, body.error.message);
  return body.data;
}

/** POST /api/vendor/products: a new product of the caller's shop, with its starting stock. */
export async function createOwnProduct(draft: ProductDraft): Promise<VendorProductView> {
  const { product } = await apiRequest({
    method: 'POST',
    path: VENDOR_PRODUCTS_PATH,
    body: checked(vendorProductCreateRequestSchema, {
      category_id: draft.categoryId,
      name: draft.name,
      price_npr: draft.priceNpr,
      stock_quantity: draft.stockQuantity,
    }),
    schema: vendorProductResponseSchema,
  });
  return product;
}

/**
 * PUT /api/vendor/products/:id. The PUT replaces every detail, so the ones the app does not edit
 * (description, unit, metadata, whether it is listed) are sent back as they are; the photos are
 * kept by leaving `image_urls` out. The stock is not part of a PUT.
 */
export async function replaceOwnProduct(
  current: VendorProductView,
  changes: Partial<Pick<VendorProductView, 'category_id' | 'name' | 'price_npr' | 'is_active'>>,
): Promise<VendorProductView> {
  const next = { ...current, ...changes };
  const { product } = await apiRequest({
    method: 'PUT',
    path: `${VENDOR_PRODUCTS_PATH}/${current.id}`,
    body: checked(vendorProductUpdateRequestSchema, {
      category_id: next.category_id,
      name: next.name,
      description: next.description,
      price_npr: next.price_npr,
      unit: next.unit,
      is_active: next.is_active,
      metadata: next.metadata,
    }),
    schema: vendorProductResponseSchema,
  });
  return product;
}

/** PATCH /api/vendor/products/:id/stock: the counted quantity (replaces the stored one). */
export async function setOwnProductStock(
  id: string,
  stockQuantity: number,
): Promise<VendorProductView> {
  const { product } = await apiRequest({
    method: 'PATCH',
    path: `${VENDOR_PRODUCTS_PATH}/${id}/stock`,
    body: { stock_quantity: stockQuantity },
    schema: vendorProductResponseSchema,
  });
  return product;
}

/** DELETE /api/vendor/products/:id: hides the product from customers (204, a soft delete). */
export async function hideOwnProduct(id: string): Promise<void> {
  await apiRequest({
    method: 'DELETE',
    path: `${VENDOR_PRODUCTS_PATH}/${id}`,
    schema: z.undefined(),
  });
}
