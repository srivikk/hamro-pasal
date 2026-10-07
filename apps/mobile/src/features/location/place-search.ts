import { isWithinNepalBoundingBox, MAX_PRODUCT_SEARCH_LENGTH } from '@hamro-pasal/shared-types';
import { useQuery } from '@tanstack/react-query';
import { z } from 'zod';

import { useDebouncedValue } from '../../lib/useDebouncedValue';

export const MAX_PLACE_SEARCH_LENGTH = MAX_PRODUCT_SEARCH_LENGTH;
/** Suggestions are fetched from this many characters on. */
export const MIN_PLACE_SEARCH_LENGTH = 2;
/**
 * Typing must rest this long before a request is made. Long on purpose while the search runs on
 * the public Nominatim server, which rate-limits to about one request per second.
 */
export const PLACE_SEARCH_DEBOUNCE_MS = 1200;
export const PLACE_SEARCH_LIMIT = 5;
const PLACE_SEARCH_TIMEOUT_MS = 8000;

/**
 * The ONE place that names the search service. OpenStreetMap's public Nominatim server, as
 * requested while there is no Google Maps key. Its usage policy does not allow type-ahead
 * (autocomplete) traffic, so this is for development only: point it at a service meant for
 * autocomplete (Photon, LocationIQ, a self-hosted Nominatim, Google Places) before launch.
 */
export const PLACE_SEARCH_URL = 'https://nominatim.openstreetmap.org/search';

/** One suggestion of the location search, ready to show and to select. */
export interface PlaceSuggestion {
  id: string;
  lat: number;
  lng: number;
  /** The area or street: the bold first line. */
  title: string;
  /** City, district, province: the grey second line (may be empty). */
  subtitle: string;
  /** What the Home header shows once selected: "Thamel, Kathmandu". */
  label: string;
}

const nominatimResultSchema = z.object({
  place_id: z.union([z.number(), z.string()]),
  lat: z.string(),
  lon: z.string(),
  display_name: z.string(),
  name: z.string().optional(),
  address: z.record(z.string(), z.unknown()).optional(),
});

const TOWN_KEYS = ['city', 'town', 'municipality', 'village', 'county'] as const;

function townOf(address: Record<string, unknown> | undefined): string | null {
  if (address === undefined) return null;
  for (const key of TOWN_KEYS) {
    const value = address[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return null;
}

/**
 * Turns a Nominatim search answer into suggestions. `display_name` is "Thamel, Kathmandu,
 * Bagmati Province, 44600, Nepal": the first part (or `name`) is the title and the rest, without
 * the country and postcodes, the subtitle. Results outside Nepal's box, and anything malformed,
 * are dropped (SPEC §1).
 */
export function toPlaceSuggestions(body: unknown): PlaceSuggestion[] {
  if (!Array.isArray(body)) return [];
  const suggestions: PlaceSuggestion[] = [];
  for (const candidate of body) {
    const parsed = nominatimResultSchema.safeParse(candidate);
    if (!parsed.success) continue;
    const { place_id: placeId, lat, lon, display_name: displayName, name, address } = parsed.data;
    const latitude = Number(lat);
    const longitude = Number(lon);
    if (!isWithinNepalBoundingBox({ lat: latitude, lng: longitude })) continue;
    const parts = displayName
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part !== '');
    const title = name !== undefined && name.trim() !== '' ? name.trim() : (parts[0] ?? '');
    if (title === '') continue;
    const rest = parts.filter(
      (part, index) => !(index === 0 && part === title) && part !== 'Nepal' && !/^\d+$/.test(part),
    );
    const town = townOf(address);
    suggestions.push({
      id: String(placeId),
      lat: latitude,
      lng: longitude,
      title,
      subtitle: rest.join(', '),
      label: town === null || town === title ? title : `${title}, ${town}`,
    });
  }
  return suggestions;
}

/** What the customer typed, as a query: trimmed, inner whitespace collapsed, length capped. */
export function toPlaceQuery(input: string): string {
  return input.trim().replace(/\s+/g, ' ').slice(0, MAX_PLACE_SEARCH_LENGTH);
}

/** GET {PLACE_SEARCH_URL}?q=…&format=json&addressdetails=1&limit=5 (Nepal only). Throws on failure. */
export async function searchPlaces(query: string): Promise<PlaceSuggestion[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, PLACE_SEARCH_TIMEOUT_MS);
  try {
    const params = `q=${encodeURIComponent(query)}&format=json&addressdetails=1&limit=${String(PLACE_SEARCH_LIMIT)}&countrycodes=np`;
    const response = await fetch(`${PLACE_SEARCH_URL}?${params}`, {
      headers: { Accept: 'application/json', 'Accept-Language': 'en' },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Place search answered ${String(response.status)}`);
    return toPlaceSuggestions((await response.json()) as unknown);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The coordinates of an area named in words ("Lalitpur Metropolitan City, Lalitpur"): the first
 * match in Nepal, or null when there is none or the search fails. Used to open the pin-drop map
 * on what the customer has already typed in the address form.
 */
export async function geocodeArea(
  query: string,
): Promise<{ latitude: number; longitude: number } | null> {
  const text = toPlaceQuery(query);
  if (text === '') return null;
  try {
    const [first] = await searchPlaces(text);
    return first === undefined ? null : { latitude: first.lat, longitude: first.lng };
  } catch {
    return null;
  }
}

export interface PlaceSuggestionsState {
  /** Two or more characters are typed: the suggestion list replaces the default view. */
  active: boolean;
  /** Waiting for typing to rest, or for the answer. */
  loading: boolean;
  failed: boolean;
  suggestions: PlaceSuggestion[];
}

/**
 * Live suggestions for the text in the location search field. Only the debounced text is ever
 * requested (a burst of keystrokes makes one request, with the last text), answers are cached
 * per query for five minutes, and nothing is asked below two characters.
 */
export function usePlaceSuggestions(input: string): PlaceSuggestionsState {
  const query = toPlaceQuery(input);
  const debounced = useDebouncedValue(query, PLACE_SEARCH_DEBOUNCE_MS);
  const active = query.length >= MIN_PLACE_SEARCH_LENGTH;
  const result = useQuery({
    queryKey: ['place-suggestions', debounced],
    queryFn: () => searchPlaces(debounced),
    enabled: debounced.length >= MIN_PLACE_SEARCH_LENGTH,
    staleTime: 5 * 60_000,
    retry: false,
  });
  const settled = active && debounced === query;
  return {
    active,
    loading: active && (!settled || result.isFetching),
    failed: settled && result.isError,
    suggestions: settled ? (result.data ?? []) : [],
  };
}
