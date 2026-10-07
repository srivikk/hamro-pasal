import { useQuery } from '@tanstack/react-query';

import { fetchFeed } from '../../api/catalog';
import { retryTransientFailures } from '../../api/query-client';
import type { CustomerLocation } from '../location/customer-location';

export function feedQueryKey(location: CustomerLocation) {
  return ['feed', location.lat, location.lng, location.municipalityPalika] as const;
}

/**
 * GET /api/vendors for the customer's location; the response is validated by feedResponseSchema.
 * `enabled: false` while no location is known: the Home screen asks for one instead.
 */
export function useFeedQuery(location: CustomerLocation, enabled = true) {
  return useQuery({
    queryKey: feedQueryKey(location),
    queryFn: () => fetchFeed(location),
    enabled,
    retry: retryTransientFailures,
  });
}
