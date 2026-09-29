import {
  feedResponseSchema,
  vendorMenuSchema,
  type FeedResponse,
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
