import {
  MAX_PRODUCT_IMAGE_BYTES,
  PRODUCT_IMAGE_CONTENT_TYPES,
  PRODUCT_IMAGE_FILE_FIELD,
  PRODUCT_LIST_MAX_LIMIT,
  vendorProductCreateRequestSchema,
  vendorProductListResponseSchema,
  vendorProductResponseSchema,
  vendorProductUpdateRequestSchema,
  type VendorProductListResponseBody,
  type VendorProductView,
} from '@hamro-pasal/shared-types';
import type { z } from 'zod';

import { localFilePart } from './file-part';
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
 * (description, unit, metadata) are sent back as they are; the photos are kept by leaving
 * `image_urls` out, the In Stock switch by leaving `in_stock` out. The stock count is not part of
 * a PUT, and since 2026-10-21 neither is whether customers see it (the Super Admin moderates).
 */
export async function replaceOwnProduct(
  current: VendorProductView,
  changes: Partial<Pick<VendorProductView, 'category_id' | 'name' | 'price_npr'>>,
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

/**
 * PATCH /api/vendor/products/:id/availability (2026-10-21): the In Stock / Out of Stock switch.
 * The count is untouched, and the product stays listed (shown out of stock).
 */
export async function setOwnProductAvailability(
  id: string,
  inStock: boolean,
): Promise<VendorProductView> {
  const { product } = await apiRequest({
    method: 'PATCH',
    path: `${VENDOR_PRODUCTS_PATH}/${id}/availability`,
    body: { in_stock: inStock },
    schema: vendorProductResponseSchema,
  });
  return product;
}

/** A photo picked on the device, before it is uploaded. */
export interface LocalPhoto {
  readonly uri: string;
  readonly mimeType: string | null;
  readonly fileSize: number | null;
}

/** Why a photo is refused on the device, before any upload (the server checks again). */
export type PhotoProblem = 'too_large' | 'not_an_image';

export function photoProblem(photo: LocalPhoto): PhotoProblem | null {
  const type = photo.mimeType ?? 'image/jpeg';
  if (!(PRODUCT_IMAGE_CONTENT_TYPES as readonly string[]).includes(type)) return 'not_an_image';
  if (photo.fileSize !== null && photo.fileSize > MAX_PRODUCT_IMAGE_BYTES) return 'too_large';
  return null;
}

/**
 * POST /api/vendor/products/:id/images (2026-10-21, Task 5): the picked photos as one
 * multipart/form-data request, each an `images` part. The server checks each file's own bytes,
 * re-encodes it (WebP, 1200 px) into object storage (S3-compatible: AWS S3, Cloudflare R2 or
 * Supabase Storage) and appends its URL; the answer is the product with every photo.
 */
export async function uploadOwnProductImages(
  id: string,
  photos: readonly LocalPhoto[],
): Promise<VendorProductView> {
  const form = new FormData();
  for (const photo of photos) form.append(PRODUCT_IMAGE_FILE_FIELD, localFilePart(photo.uri));
  const { product } = await apiRequest({
    method: 'POST',
    path: `${VENDOR_PRODUCTS_PATH}/${encodeURIComponent(id)}/images`,
    body: form,
    schema: vendorProductResponseSchema,
  });
  return product;
}
