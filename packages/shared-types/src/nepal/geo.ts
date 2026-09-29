/**
 * Nepal's extreme points (26°20′49″N – 30°26′49″N, 80°03′29″E – 88°12′04″E), shared by every
 * coarse "is this inside Nepal?" check: the mobile territory gate (SPEC §1), address pin
 * validation and the backend's coordinate validation. One constant, so a coordinate can never
 * pass one check and fail another.
 *
 * A rectangle also covers slices of India and China, so it only rules coordinates out. The
 * authoritative country decision is the reverse-geocoder / PostGIS polygon lookup (SPEC §1).
 */
export const NEPAL_BOUNDING_BOX = {
  minLat: 26.347,
  maxLat: 30.447,
  minLng: 80.058,
  maxLng: 88.201,
} as const;

export interface LatLng {
  readonly lat: number;
  readonly lng: number;
}

export function isWithinNepalBoundingBox({ lat, lng }: LatLng): boolean {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= NEPAL_BOUNDING_BOX.minLat &&
    lat <= NEPAL_BOUNDING_BOX.maxLat &&
    lng >= NEPAL_BOUNDING_BOX.minLng &&
    lng <= NEPAL_BOUNDING_BOX.maxLng
  );
}
