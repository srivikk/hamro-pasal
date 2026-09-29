import { useQuery } from '@tanstack/react-query';

import type { CustomerLocation } from '../feed/serviceability';
import { fetchMockVendorMenu, VendorNotFoundError } from './mock-menu-api';

export function vendorMenuQueryKey(vendorId: string, customer: CustomerLocation) {
  return ['vendor-menu', vendorId, customer.point.y, customer.point.x] as const;
}

export function useVendorMenuQuery(vendorId: string, customer: CustomerLocation) {
  return useQuery({
    queryKey: vendorMenuQueryKey(vendorId, customer),
    queryFn: () => fetchMockVendorMenu(vendorId, customer),
    // An unknown vendor will not appear by retrying; transient failures still retry.
    retry: (failureCount, error) => !(error instanceof VendorNotFoundError) && failureCount < 3,
  });
}
