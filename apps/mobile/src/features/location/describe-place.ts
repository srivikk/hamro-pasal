import * as Location from 'expo-location';
import { z } from 'zod';

import type { Coordinates } from '../territory/territory';

/** How long the OpenStreetMap fallback may take before the place is left unnamed. */
const NOMINATIM_TIMEOUT_MS = 5000;
const NOMINATIM_REVERSE_URL = 'https://nominatim.openstreetmap.org/reverse';

/** The first two distinct, non-blank names, joined: "Thamel Marg, Kathmandu". */
function joinNames(candidates: readonly (string | null | undefined)[]): string | null {
  const parts: string[] = [];
  for (const candidate of candidates) {
    const part = typeof candidate === 'string' ? candidate.trim() : '';
    if (part !== '' && !parts.includes(part)) parts.push(part);
  }
  return parts.length === 0 ? null : parts.slice(0, 2).join(', ');
}

/** A readable name from the device geocoder's answer: street, then area, then town. */
export function placeName(place: Location.LocationGeocodedAddress | undefined): string | null {
  if (place === undefined) return null;
  return joinNames([place.street, place.district, place.city, place.subregion]);
}

const nominatimSchema = z.object({
  address: z
    .object({
      road: z.string().optional(),
      neighbourhood: z.string().optional(),
      suburb: z.string().optional(),
      village: z.string().optional(),
      town: z.string().optional(),
      city: z.string().optional(),
      municipality: z.string().optional(),
      county: z.string().optional(),
    })
    .optional(),
});

/** A readable name from an OpenStreetMap Nominatim reverse answer, or null when it names nothing. */
export function nominatimPlaceName(body: unknown): string | null {
  const parsed = nominatimSchema.safeParse(body);
  if (!parsed.success || parsed.data.address === undefined) return null;
  const { road, neighbourhood, suburb, village, town, city, municipality, county } =
    parsed.data.address;
  return joinNames([road, neighbourhood, suburb, village, town, city, municipality, county]);
}

async function fromDevice(coordinates: Coordinates): Promise<string | null> {
  const [place] = await Location.reverseGeocodeAsync(coordinates);
  return placeName(place);
}

async function fromNominatim(coordinates: Coordinates): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, NOMINATIM_TIMEOUT_MS);
  try {
    const query = `format=jsonv2&addressdetails=1&zoom=17&lat=${String(coordinates.latitude)}&lon=${String(coordinates.longitude)}`;
    const response = await fetch(`${NOMINATIM_REVERSE_URL}?${query}`, {
      headers: { Accept: 'application/json', 'Accept-Language': 'en' },
      signal: controller.signal,
    });
    if (!response.ok) return null;
    return nominatimPlaceName((await response.json()) as unknown);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The human-readable name of a position ("Thamel Marg, Kathmandu"): what the Home header, the
 * location selector and the address form show instead of latitude and longitude. The device's
 * own geocoder is asked first (no key, no network on some phones); when it fails or names
 * nothing, OpenStreetMap's Nominatim is asked. Null when neither can name the place: callers then
 * show a neutral label ("Current location", "Pinned location"), never the coordinates.
 *
 * Never throws. Nominatim's public server is rate limited (1 request per second per app) and is
 * only the fallback; a production build should use a keyed geocoding service instead.
 */
export async function describePlace(coordinates: Coordinates): Promise<string | null> {
  try {
    const name = await fromDevice(coordinates);
    if (name !== null) return name;
  } catch {
    // Fall through to OpenStreetMap.
  }
  try {
    return await fromNominatim(coordinates);
  } catch {
    return null;
  }
}
