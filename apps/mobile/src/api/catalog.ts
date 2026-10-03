import {
  categoryListResponseSchema,
  feedResponseSchema,
  productListResponseSchema,
  vendorMenuSchema,
  type CategoryListResponseBody,
  type FeedResponse,
  type ProductListResponseBody,
  type VendorMenu,
} from '@hamro-pasal/shared-types';

import type { CustomerLocation } from '../features/location/customer-location';
import { apiRequest } from './http';

export const VENDORS_PATH = '/api/vendors';

export function vendorProductsPath(vendorId: string): string {
  return `${VENDORS_PATH}/${encodeURIComponent(vendorId)}/products`;
}

/** Server-side vendor lookups return 404 with this code for unknown or non-LIVE vendors. */
export const VENDOR_NOT_FOUND = 'VENDOR_NOT_FOUND';

function locationQuery(location: CustomerLocation): Record<string, string> {
  return {
    lat: String(location.lat),
    lng: String(location.lng),
    ...(location.municipalityPalika === null
      ? {}
      : { municipality_palika_string: location.municipalityPalika }),
  };
}

/** GET /api/vendors: LIVE vendors split by SPEC §2 serviceability (PostGIS), nearest first. */
export function fetchFeed(location: CustomerLocation): Promise<FeedResponse> {
  return apiRequest({
    method: 'GET',
    path: VENDORS_PATH,
    query: locationQuery(location),
    schema: feedResponseSchema,
  });
}

/** GET /api/vendors/:id/products: a LIVE vendor's active catalogue with real product ids. */
export function fetchVendorMenu(vendorId: string, location: CustomerLocation): Promise<VendorMenu> {
  return apiRequest({
    method: 'GET',
    path: vendorProductsPath(vendorId),
    query: locationQuery(location),
    schema: vendorMenuSchema,
  });
}

/* ---------- Phase 18: the public taxonomy and product list (no token needed) ---------- */

export const CATEGORIES_PATH = '/api/categories';
export const PRODUCTS_PATH = '/api/products';

/** GET /api/products answers 404 with this code for an unknown or hidden `category_id`. */
export const CATEGORY_NOT_FOUND = 'CATEGORY_NOT_FOUND';

/** GET /api/categories: the active taxonomy as a flat list in tree order. */
export function fetchCategories(): Promise<CategoryListResponseBody> {
  return apiRequest({
    method: 'GET',
    path: CATEGORIES_PATH,
    authenticated: false,
    schema: categoryListResponseSchema,
  });
}

export interface ProductListFilter {
  /** A category and its active descendants; null lists every category. */
  categoryId: string | null;
  /** Word-prefix full-text search on name and description; null does not search. */
  search: string | null;
}

/**
 * GET /api/products: one page of active products of LIVE vendors, by name. `cursor` is the
 * previous page's `next_cursor`.
 */
export function fetchProducts(
  { categoryId, search }: ProductListFilter,
  cursor: string | null = null,
): Promise<ProductListResponseBody> {
  return apiRequest({
    method: 'GET',
    path: PRODUCTS_PATH,
    query: {
      ...(categoryId === null ? {} : { category_id: categoryId }),
      ...(search === null ? {} : { search }),
      ...(cursor === null ? {} : { cursor }),
    },
    authenticated: false,
    schema: productListResponseSchema,
  });
}
