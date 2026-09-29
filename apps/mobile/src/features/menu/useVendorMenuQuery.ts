import { useQuery } from '@tanstack/react-query';

import { fetchVendorMenu } from '../../api/catalog';
import { retryTransientFailures } from '../../api/query-client';
import type { CustomerLocation } from '../location/customer-location';

export function vendorMenuQueryKey(vendorId: string, location: CustomerLocation) {
  return [
    'vendor-menu',
    vendorId,
    location.lat,
    location.lng,
    location.municipalityPalika,
  ] as const;
}

/** GET /api/vendors/:id/products; the response is validated by vendorMenuSchema. */
export function useVendorMenuQuery(vendorId: string, location: CustomerLocation) {
  return useQuery({
    queryKey: vendorMenuQueryKey(vendorId, location),
    queryFn: () => fetchVendorMenu(vendorId, location),
    // An unknown vendor (404 VENDOR_NOT_FOUND) will not appear by retrying.
    retry: retryTransientFailures,
  });
}
