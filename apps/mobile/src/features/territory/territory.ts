import { NEPAL_BOUNDING_BOX } from '@hamro-pasal/shared-types';

/*
 * Tenant isolation (SPEC §1): the platform serves country_code 'NP' only. Pure decision logic,
 * separate from the device APIs, so every branch is unit-tested.
 */

/** The exact blocking message SPEC §1 prescribes (its spelling is kept verbatim). */
export const TERRITORY_BLOCKED_MESSAGE = 'Service Unvailable in your territory';

export const SERVICE_COUNTRY_CODE = 'NP';

/**
 * Nepal's extreme points, shared with address validation and the API. A rectangle, so it also
 * covers slices of India and China (see below).
 */
export const NEPAL_TERRITORY_BOX = NEPAL_BOUNDING_BOX;

export interface Coordinates {
  latitude: number;
  longitude: number;
}

export type TerritoryVerdict =
  | { status: 'allowed'; coordinates: Coordinates }
  | { status: 'blocked'; coordinates: Coordinates }
  /** Location permission refused: nationality cannot be checked, so the app stays locked. */
  | { status: 'permission_denied'; canAskAgain: boolean }
  /** No position fix (GPS off, timeout). Retryable; the app stays locked meanwhile. */
  | { status: 'unavailable' };

export function isWithinNepalBox({ latitude, longitude }: Coordinates): boolean {
  return (
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    latitude >= NEPAL_TERRITORY_BOX.minLat &&
    latitude <= NEPAL_TERRITORY_BOX.maxLat &&
    longitude >= NEPAL_TERRITORY_BOX.minLng &&
    longitude <= NEPAL_TERRITORY_BOX.maxLng
  );
}

/**
 * Decides whether a position is in the service territory.
 *
 * Outside the box it is never Nepal: blocked without asking anyone. Inside the box the rectangle
 * alone is not enough (Gorakhpur, India, and parts of Tibet fall inside it), so the device's
 * reverse-geocoded country decides (SPEC §1: reverse geocoding). When no country could be
 * resolved (offline, geocoder unavailable) the box verdict stands, so customers in Nepal are not
 * locked out by a flaky network.
 */
export function decideTerritory(
  coordinates: Coordinates,
  countryCode: string | null,
): TerritoryVerdict {
  if (!isWithinNepalBox(coordinates)) return { status: 'blocked', coordinates };
  if (countryCode !== null && countryCode.toUpperCase() !== SERVICE_COUNTRY_CODE) {
    return { status: 'blocked', coordinates };
  }
  return { status: 'allowed', coordinates };
}

/** The device services the check needs; injected so tests and the __DEV__ simulator can replace them. */
export interface TerritoryDeps {
  requestPermission: () => Promise<{ granted: boolean; canAskAgain: boolean }>;
  /** Best available position, or null when none could be obtained in time. */
  getPosition: () => Promise<Coordinates | null>;
  /** ISO 3166-1 alpha-2 country of a position, or null when it cannot be resolved. */
  reverseGeocodeCountry: (coordinates: Coordinates) => Promise<string | null>;
}

export async function checkTerritory(deps: TerritoryDeps): Promise<TerritoryVerdict> {
  const permission = await deps.requestPermission();
  if (!permission.granted) {
    return { status: 'permission_denied', canAskAgain: permission.canAskAgain };
  }
  const coordinates = await deps.getPosition();
  if (coordinates === null) return { status: 'unavailable' };
  // Outside the box, geocoding cannot change the answer, so no network call is made.
  if (!isWithinNepalBox(coordinates)) return { status: 'blocked', coordinates };
  let countryCode: string | null;
  try {
    countryCode = await deps.reverseGeocodeCountry(coordinates);
  } catch {
    countryCode = null;
  }
  return decideTerritory(coordinates, countryCode);
}
