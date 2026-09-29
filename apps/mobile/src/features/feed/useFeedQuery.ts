import { useQuery } from '@tanstack/react-query';

import { fetchMockFeed } from './mock-feed-api';
import type { CustomerLocation } from './serviceability';

export function feedQueryKey(customer: CustomerLocation) {
  return ['feed', customer.point.y, customer.point.x, customer.municipality_palika_string] as const;
}

export function useFeedQuery(customer: CustomerLocation) {
  return useQuery({
    queryKey: feedQueryKey(customer),
    queryFn: () => fetchMockFeed(customer),
  });
}
