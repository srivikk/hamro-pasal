import type { DeliverySettingsResponseBody } from '@hamro-pasal/shared-types';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { retryTransientFailures } from '../../api/query-client';
import {
  fetchDeliverySettings,
  saveDeliverySettings,
  type DeliverySettingsDraft,
} from '../../api/vendor-delivery-settings';

export const DELIVERY_SETTINGS_QUERY_KEY = ['vendor', 'delivery-settings'] as const;

/** The shop's delivery settings as the server holds them, with the platform's switches. */
export function useDeliverySettingsQuery() {
  return useQuery({
    queryKey: DELIVERY_SETTINGS_QUERY_KEY,
    queryFn: fetchDeliverySettings,
    staleTime: 0,
    retry: retryTransientFailures,
  });
}

/**
 * Saves the delivery settings. Never retried automatically. The server's answer becomes the
 * cached settings at once, so the form shows exactly what was stored; then the query is refetched.
 */
export function useSaveDeliverySettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (draft: DeliverySettingsDraft) => saveDeliverySettings(draft),
    retry: false,
    onSuccess: (result) => {
      queryClient.setQueryData<DeliverySettingsResponseBody>(DELIVERY_SETTINGS_QUERY_KEY, result);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: DELIVERY_SETTINGS_QUERY_KEY }),
  });
}
