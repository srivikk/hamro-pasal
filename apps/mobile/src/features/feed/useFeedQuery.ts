import { useQuery } from '@tanstack/react-query';

import { fetchFeed } from '../../api/catalog';
import { retryTransientFailures } from '../../api/query-client';
import type { CustomerLocation } from '../location/customer-location';

export function feedQueryKey(location: CustomerLocation) {
  return ['feed', location.lat, location.lng, location.municipalityPalika] as const;
}

/** GET /api/vendors for the customer's location; the response is validated by feedResponseSchema. */
export function useFeedQuery(location: CustomerLocation) {
  return useQuery({
    queryKey: feedQueryKey(location),
    queryFn: () => fetchFeed(location),
    retry: retryTransientFailures,
  });
}
