import type { NepalAddress } from '@hamro-pasal/shared-types';
import { useMemo } from 'react';

import { useAddressStore } from '../../store/useAddressStore';
import { useBrowseLocationStore } from '../../store/useBrowseLocationStore';

/** Where the feed and menus are evaluated from (SPEC §2 serviceability runs on the server). */
export interface CustomerLocation {
  lat: number;
  lng: number;
  /** Sent so CITY_WIDE vendors can match the customer's Palika; null when unknown. */
  municipalityPalika: string | null;
}

/**
 * Thamel, Kathmandu Metropolitan City (the seeded customer's neighbourhood). Only what a query is
 * asked with while no location is known at all; the Home screen then asks the customer to select
 * one instead of listing shops (`useHasBrowseLocation`).
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

/**
 * Where the customer is browsing from, in this order: the place chosen in the Home header, the
 * device position captured at boot, the selected delivery address, else Thamel. The feed and
 * every menu follow it.
 */
export function useCustomerLocation(): CustomerLocation {
  const address = useAddressStore((state) => state.address);
  const override = useBrowseLocationStore((state) => state.override);
  const device = useBrowseLocationStore((state) => state.device);
  return useMemo(() => {
    if (override !== null) {
      return {
        lat: override.lat,
        lng: override.lng,
        municipalityPalika: override.municipalityPalika,
      };
    }
    // A GPS fix names no Palika, so CITY_WIDE shops match only through an address.
    if (device !== null) return { lat: device.lat, lng: device.lng, municipalityPalika: null };
    return customerLocationFrom(address);
  }, [address, override, device]);
}

/** False when location was refused or skipped and nothing was selected: Home asks for one. */
export function useHasBrowseLocation(): boolean {
  const hasAddress = useAddressStore((state) => state.address !== null);
  const hasOverride = useBrowseLocationStore((state) => state.override !== null);
  const hasDevice = useBrowseLocationStore((state) => state.device !== null);
  return hasOverride || hasDevice || hasAddress;
}
