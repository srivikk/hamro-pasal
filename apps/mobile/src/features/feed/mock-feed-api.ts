import type { VendorStatus } from '@hamro-pasal/shared-types';

import {
  feedResponseSchema,
  type FeedEntry,
  type FeedResponse,
  type FeedVendor,
} from './feed-contract';
import { distanceKm, isServiceable, type CustomerLocation } from './serviceability';

/*
 * MOCK feed API. Stands in for the server-side PostGIS feed until the backend endpoint exists.
 * Data mirrors the dev seed (Kathmandu valley) plus vendors that exercise every SPEC §2 branch.
 */

export interface MockVendorRecord extends FeedVendor {
  status: VendorStatus;
}

/** Seeded customer Aarav: Thamel, Kathmandu Metropolitan City, ward 26. */
export const MOCK_CUSTOMER_LOCATION: CustomerLocation = {
  point: { x: 85.3123, y: 27.7154 },
  municipality_palika_string: 'Kathmandu Metropolitan City',
};

export const MOCK_VENDORS: readonly MockVendorRecord[] = [
  {
    // Seed: RADIUS_BOUND 5 km, next door to the customer.
    id: '6f1c2a10-0000-4000-8000-000000000011',
    business_name: 'Thamel Kirana Pasal',
    status: 'LIVE',
    delivery_scope: 'RADIUS_BOUND',
    radius_km: 5,
    municipality_palika_string: 'Kathmandu Metropolitan City',
    min_order_value: 500,
    base_delivery_fee_npr: 50,
    fulfillment_mode: 'SELF_DELIVERY',
    location: { x: 85.3123, y: 27.7154 },
  },
  {
    // ~5.2 km away with a 5 km radius: serviceable only thanks to the 10% GPS drift buffer.
    id: '6f1c2a10-0000-4000-8000-000000000014',
    business_name: 'Boudha Fresh Mart',
    status: 'LIVE',
    delivery_scope: 'RADIUS_BOUND',
    radius_km: 5,
    municipality_palika_string: 'Kathmandu Metropolitan City',
    min_order_value: 300,
    base_delivery_fee_npr: 60,
    fulfillment_mode: 'PLATFORM_FLEET',
    location: { x: 85.365, y: 27.7215 },
  },
  {
    // CITY_WIDE in the customer's own Palika.
    id: '6f1c2a10-0000-4000-8000-000000000015',
    business_name: 'New Road Electronics',
    status: 'LIVE',
    delivery_scope: 'CITY_WIDE',
    radius_km: 1,
    municipality_palika_string: 'Kathmandu Metropolitan City',
    min_order_value: 1000,
    base_delivery_fee_npr: 100,
    fulfillment_mode: 'SELF_DELIVERY',
    location: { x: 85.31, y: 27.704 },
  },
  {
    // NATION_WIDE: serviceable from ~140 km away.
    id: '6f1c2a10-0000-4000-8000-000000000016',
    business_name: 'Pokhara Dhaka Topi Bhandar',
    status: 'LIVE',
    delivery_scope: 'NATION_WIDE',
    radius_km: 1,
    municipality_palika_string: 'Pokhara Metropolitan City',
    min_order_value: 1500,
    base_delivery_fee_npr: 250,
    fulfillment_mode: 'PLATFORM_FLEET',
    location: { x: 83.9856, y: 28.2096 },
  },
  {
    // Seed: CITY_WIDE Lalitpur. The customer is in Kathmandu, so: Explore Further.
    id: '6f1c2a10-0000-4000-8000-000000000012',
    business_name: 'Patan Organic Store',
    status: 'LIVE',
    delivery_scope: 'CITY_WIDE',
    radius_km: 1,
    municipality_palika_string: 'Lalitpur Metropolitan City',
    min_order_value: 400,
    base_delivery_fee_npr: 80,
    fulfillment_mode: 'PLATFORM_FLEET',
    location: { x: 85.3188, y: 27.6795 },
  },
  {
    // RADIUS_BOUND 3 km, ~5 km away: beyond even the buffered 3.3 km. Explore Further.
    id: '6f1c2a10-0000-4000-8000-000000000017',
    business_name: 'Kirtipur Tarkari Pasal',
    status: 'LIVE',
    delivery_scope: 'RADIUS_BOUND',
    radius_km: 3,
    municipality_palika_string: 'Kirtipur Municipality',
    min_order_value: 200,
    base_delivery_fee_npr: 40,
    fulfillment_mode: 'SELF_DELIVERY',
    location: { x: 85.2775, y: 27.6788 },
  },
  {
    // Seed: APPROVED, not LIVE. Never shown in any feed section.
    id: '6f1c2a10-0000-4000-8000-000000000013',
    business_name: 'Bhaktapur Juju Dhau Bhandar',
    status: 'APPROVED',
    delivery_scope: 'NATION_WIDE',
    radius_km: 1,
    municipality_palika_string: 'Bhaktapur Municipality',
    min_order_value: 250,
    base_delivery_fee_npr: 120,
    fulfillment_mode: 'SELF_DELIVERY',
    location: { x: 85.4298, y: 27.671 },
  },
];

/** What the server feed does: LIVE vendors only, split by serviceability, nearest first. */
export function buildFeed(
  vendors: readonly MockVendorRecord[],
  customer: CustomerLocation,
): FeedResponse {
  const entries: FeedEntry[] = vendors
    .filter((vendor) => vendor.status === 'LIVE')
    .map(({ status: _status, ...vendor }) => {
      const distance = distanceKm(customer.point, vendor.location);
      return {
        vendor,
        distance_km: distance,
        serviceable: isServiceable(vendor, customer.municipality_palika_string, distance),
      };
    })
    .sort((a, b) => a.distance_km - b.distance_km);

  return feedResponseSchema.parse({
    serviceable: entries.filter((entry) => entry.serviceable),
    explore_further: entries.filter((entry) => !entry.serviceable),
  });
}

export async function fetchMockFeed(
  customer: CustomerLocation,
  { latencyMs = 400 }: { latencyMs?: number } = {},
): Promise<FeedResponse> {
  // Simulated network round trip, so loading states are visible during development.
  await new Promise((resolve) => setTimeout(resolve, latencyMs));
  return buildFeed(MOCK_VENDORS, customer);
}
