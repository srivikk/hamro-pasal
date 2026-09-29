import type { DeliveryScope, GeoPoint } from '@hamro-pasal/shared-types';

/** SPEC §2: RADIUS_BOUND vendors get a 10% grace buffer for GPS drift. */
export const GPS_DRIFT_BUFFER = 1.1;

/** Mean Earth radius (IUGG), in km. */
const EARTH_RADIUS_KM = 6371.0088;

export interface CustomerLocation {
  /** x = longitude, y = latitude (WGS 84), same convention as the API's GeoPoint. */
  point: GeoPoint;
  municipality_palika_string: string;
}

export interface ServiceabilityInput {
  delivery_scope: DeliveryScope;
  radius_km: number;
  municipality_palika_string: string;
}

/** Great-circle (haversine) distance in km between two GeoPoints. */
export function distanceKm(a: GeoPoint, b: GeoPoint): number {
  const toRad = (deg: number): number => (deg * Math.PI) / 180;
  const dLat = toRad(b.y - a.y);
  const dLng = toRad(b.x - a.x);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.y)) * Math.cos(toRad(b.y)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * SPEC §2: serviceable if NATION_WIDE, or CITY_WIDE with the same Palika, or RADIUS_BOUND with
 * D <= radius x 1.1. Palika names match exactly, as in the server's SQL.
 */
export function isServiceable(
  vendor: ServiceabilityInput,
  customerPalika: string,
  customerDistanceKm: number,
): boolean {
  switch (vendor.delivery_scope) {
    case 'NATION_WIDE':
      return true;
    case 'CITY_WIDE':
      return vendor.municipality_palika_string === customerPalika;
    case 'RADIUS_BOUND':
      return customerDistanceKm <= vendor.radius_km * GPS_DRIFT_BUFFER;
  }
}
