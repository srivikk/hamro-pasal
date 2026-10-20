import {
  availabilityResponseSchema,
  type AvailabilityRequest,
  type AvailabilityResponseBody,
} from '@hamro-pasal/shared-types';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiRequest } from '../../api/http';
import { retryTransientFailures } from '../../api/query-client';
import { useVendorShopStore } from '../../store/useVendorShopStore';

export const AVAILABILITY_PATH = '/api/vendor/availability';
export const AVAILABILITY_QUERY_KEY = ['vendor', 'availability'] as const;

/** GET /api/vendor/availability: whether the shop takes orders now, and why not. */
export function fetchAvailability(): Promise<AvailabilityResponseBody> {
  return apiRequest({ method: 'GET', path: AVAILABILITY_PATH, schema: availabilityResponseSchema });
}

/** PUT /api/vendor/availability: AUTO follows the hours and resumes an auto-paused shop. */
export function saveAvailability(body: AvailabilityRequest): Promise<AvailabilityResponseBody> {
  return apiRequest({
    method: 'PUT',
    path: AVAILABILITY_PATH,
    body,
    schema: availabilityResponseSchema,
  });
}

/**
 * Step 7.3: the shop's standing as the server decides it (hours, the switch, Auto-Pause). The
 * phone's copy (`useVendorShopStore.online`) follows the server's answer, so the dashboard's
 * offline banner agrees with the header.
 */
export function useVendorAvailability() {
  const queryClient = useQueryClient();
  const setOnline = useVendorShopStore((state) => state.setOnline);
  const query = useQuery({
    queryKey: AVAILABILITY_QUERY_KEY,
    queryFn: async () => {
      const result = await fetchAvailability();
      setOnline(result.open_now);
      return result;
    },
    staleTime: 0,
    // The standing changes on the server's side too (a PAN verified, Auto-Pause, the clock): read
    // it again whenever the app returns to the foreground (see app-focus.ts).
    refetchOnWindowFocus: 'always',
    retry: retryTransientFailures,
  });
  const save = useMutation({
    mutationFn: saveAvailability,
    retry: false,
    onSuccess: (result) => {
      queryClient.setQueryData<AvailabilityResponseBody>(AVAILABILITY_QUERY_KEY, result);
      setOnline(result.open_now);
    },
  });
  return { query, save };
}
