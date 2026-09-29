import type { NepalAddress } from '@hamro-pasal/shared-types';
import { useMemo } from 'react';

import { useAddressStore } from '../../store/useAddressStore';

/** Where the feed and menus are evaluated from (SPEC §2 serviceability runs on the server). */
export interface CustomerLocation {
  lat: number;
  lng: number;
  /** Sent so CITY_WIDE vendors can match the customer's Palika; null when unknown. */
  municipalityPalika: string | null;
}

/**
 * Thamel, Kathmandu Metropolitan City (the seeded customer's neighbourhood). Used until the
 * customer saves a delivery address; live GPS for the feed is a later phase.
 */
export const THAMEL_FALLBACK_LOCATION: CustomerLocation = {
  lat: 27.7154,
  lng: 85.3123,
  municipalityPalika: 'Kathmandu Metropolitan City',
};

/** The saved address's dropped pin (exact_lat / exact_lng) and Palika, or the Thamel fallback. */
export function customerLocationFrom(address: NepalAddress | null): CustomerLocation {
  if (address === null) return THAMEL_FALLBACK_LOCATION;
  return {
    lat: address.exact_lat,
    lng: address.exact_lng,
    municipalityPalika: address.municipality_palika_string,
  };
}

/** The customer location, following the saved address in encrypted MMKV. */
export function useCustomerLocation(): CustomerLocation {
  const address = useAddressStore((state) => state.address);
  return useMemo(() => customerLocationFrom(address), [address]);
}
