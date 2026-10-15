import {
  adProducts,
  adPurchases,
  platformSettings,
  products,
  vendors,
  type Database,
  type Executor,
} from '@hamro-pasal/db';
import {
  DELIVERY_RADIUS_GPS_DRIFT_MULTIPLIER,
  GEO_SRID,
  type GeoPoint,
  type ShopClosedReason,
  type VendorFeedQuery,
  type VendorFulfillmentMode,
} from '@hamro-pasal/shared-types';
import { and, asc, eq, gt, inArray, lte, sql, type SQL } from 'drizzle-orm';

/**
 * Upper bound per feed section. A NATION_WIDE catalogue can grow without limit, and the mobile
 * feed has no pagination yet, so each section returns at most this many vendors, nearest first.
 */
export const FEED_SECTION_LIMIT = 100;

export class VendorNotFoundError extends Error {
  constructor(readonly vendorId: string) {
    super(`Vendor ${vendorId} not found`);
    this.name = 'VendorNotFoundError';
  }
}

export interface CatalogVendor {
  readonly id: string;
  readonly businessName: string;
  readonly deliveryScope: 'RADIUS_BOUND' | 'CITY_WIDE' | 'NATION_WIDE';
  readonly radiusKm: number;
  readonly municipalityPalika: string;
  readonly minOrderValue: number;
  readonly baseDeliveryFee: number;
  /** Step 7.2: free delivery from this subtotal; null when none, or under platform delivery. */
  readonly freeDeliveryAboveNpr: number | null;
  readonly fulfillmentMode: VendorFulfillmentMode;
  readonly location: GeoPoint;
  /** Geodesic distance from the customer (WGS 84 spheroid), in metres. */
  readonly distanceM: number;
  readonly serviceable: boolean;
  /** The shop's delivery mode is one the Super Admin has switched on (else it is forced Offline). */
  readonly deliveryAvailable: boolean;
  /** One of the (at most two) sponsored listings leading the serviceable section. */
  readonly sponsored?: boolean;
  /** Step 7.3: why the shop takes no order now (hours, its switch, Auto-Pause); null when open. */
  readonly closedReason: ShopClosedReason | null;
}

/** SPEC core 8, "Sponsored feed listings": at most this many lead the feed. */
export const SPONSORED_FEED_LIMIT = 2;

export interface VendorFeed {
  readonly serviceable: readonly CatalogVendor[];
  readonly unserviceable: readonly CatalogVendor[];
  /** False during the global Emergency Stop: both delivery modes are switched off. */
  readonly deliveryAvailable: boolean;
}

export interface MenuProduct {
  readonly id: string;
  readonly name: string;
  readonly priceNpr: number;
  readonly inStock: boolean;
  /** The vendor's on-hand count (Phase 19: the app caps cart lines added from the menu with it). */
  readonly stockQuantity: number;
}

export interface VendorMenu {
  readonly vendor: CatalogVendor;
  readonly products: readonly MenuProduct[];
}

/**
 * Read side of the customer catalogue (SPEC §2, customer journey 3). Serviceability is decided
 * in PostGIS, per vendor, from its delivery_scope:
 *   NATION_WIDE   always
 *   CITY_WIDE     the customer's Palika equals the vendor's municipality_palika_string
 *   RADIUS_BOUND  geodesic distance D <= radius_km x 1.1 (the 10% GPS-drift grace buffer)
 * Only LIVE vendors are ever returned.
 */
export class CatalogService {
  constructor(private readonly db: Database) {}

  /** GET /api/vendors: every LIVE vendor, split into serviceable / unserviceable, nearest first. */
  async listFeed(customer: VendorFeedQuery): Promise<VendorFeed> {
    const modes = await enabledModes(this.db);
    // The Emergency Stop: with both delivery modes off there is no shop to list.
    if (modes.length === 0) return { serviceable: [], unserviceable: [], deliveryAvailable: false };
    const rows = await this.db
      .select(this.vendorColumns(customer, modes))
      .from(vendors)
      .where(eq(vendors.status, 'LIVE'))
      .orderBy(sql`distance_m`, asc(vendors.id));

    const all = rows.map(toCatalogVendor);
    const advertisers = await this.feedAdvertisers();
    return {
      serviceable: withSponsoredFirst(
        all.filter((v) => v.serviceable),
        advertisers,
      ).slice(0, FEED_SECTION_LIMIT),
      unserviceable: all.filter((v) => !v.serviceable).slice(0, FEED_SECTION_LIMIT),
      deliveryAvailable: true,
    };
  }

  /** GET /api/vendors/:id/products: a LIVE vendor's active catalogue with real product ids. */
  async getMenu(vendorId: string, customer: VendorFeedQuery): Promise<VendorMenu> {
    const [row] = await this.db
      .select(this.vendorColumns(customer, await enabledModes(this.db)))
      .from(vendors)
      .where(and(eq(vendors.id, vendorId), eq(vendors.status, 'LIVE')));
    if (row === undefined) {
      throw new VendorNotFoundError(vendorId);
    }
    const catalogue = await this.db
      .select({
        id: products.id,
        name: products.name,
        price_npr: products.price_npr,
        stock_quantity: products.stock_quantity,
      })
      .from(products)
      .where(and(eq(products.vendor_id, vendorId), eq(products.is_active, true)))
      .orderBy(asc(products.name));

    return {
      vendor: toCatalogVendor(row),
      products: catalogue.map((p) => ({
        id: p.id,
        name: p.name,
        priceNpr: p.price_npr,
        // Stock held by other customers' 600 s locks is not subtracted here: checkout re-checks
        // availability under the lock and answers INSUFFICIENT_STOCK precisely.
        inStock: p.stock_quantity > 0,
        stockQuantity: p.stock_quantity,
      })),
    };
  }

  /** Shops whose own FEED_LISTING ad purchase is running now (ACTIVE, inside its paid period). */
  private async feedAdvertisers(): Promise<ReadonlySet<string>> {
    const rows = await this.db
      .selectDistinct({ vendorId: adPurchases.vendor_id })
      .from(adPurchases)
      .innerJoin(adProducts, eq(adProducts.id, adPurchases.ad_product_id))
      .where(
        and(
          eq(adProducts.slot, 'FEED_LISTING'),
          eq(adPurchases.status, 'ACTIVE'),
          lte(adPurchases.starts_at, sql`now()`),
          gt(adPurchases.ends_at, sql`now()`),
        ),
      );
    return new Set(rows.map((row) => row.vendorId));
  }

  private vendorColumns(customer: VendorFeedQuery, modes: readonly VendorFulfillmentMode[]) {
    return {
      id: vendors.id,
      business_name: vendors.business_name,
      delivery_scope: vendors.delivery_scope,
      radius_km: vendors.radius_km,
      municipality_palika_string: vendors.municipality_palika_string,
      min_order_value: vendors.min_order_value,
      base_delivery_fee_npr: vendors.base_delivery_fee_npr,
      free_delivery_above_npr: vendors.free_delivery_above_npr,
      fulfillment_mode: vendors.fulfillment_mode,
      location: vendors.location,
      distance_m:
        sql<number>`ST_Distance(${vendors.location}::geography, ${customerPoint(customer)})`
          .mapWith(Number)
          .as('distance_m'),
      serviceable: deliversTo(customer, modes).mapWith(Boolean).as('serviceable'),
      delivery_available: modeEnabled(modes).mapWith(Boolean).as('delivery_available'),
      closed_reason: closedReason().as('closed_reason'),
    };
  }
}

/**
 * SPEC core 8, "Sponsored feed listings". `serviceable` is the shops that deliver to the customer,
 * nearest first. The nearest two advertisers among them (and only shops that can take an order:
 * their delivery mode is on) move to the top, flagged; every other shop, a third advertiser
 * included, keeps its place unflagged, so the badge always means "this position was paid for".
 * A shop that does not deliver here is never in this list, so an ad never overrides delivery rules.
 */
export function withSponsoredFirst(
  serviceable: readonly CatalogVendor[],
  advertisers: ReadonlySet<string>,
): CatalogVendor[] {
  const sponsored = serviceable
    .filter((vendor) => advertisers.has(vendor.id) && vendor.deliveryAvailable)
    .slice(0, SPONSORED_FEED_LIMIT);
  if (sponsored.length === 0) return [...serviceable];
  const lead = new Set(sponsored.map((vendor) => vendor.id));
  return [
    ...sponsored.map((vendor) => ({ ...vendor, sponsored: true })),
    ...serviceable.filter((vendor) => !lead.has(vendor.id)),
  ];
}

export interface DeliveryPoint {
  readonly lat: number;
  readonly lng: number;
  readonly municipality_palika_string?: string | undefined;
}

function customerPoint(customer: DeliveryPoint): SQL {
  return sql`ST_SetSRID(ST_MakePoint(${customer.lng}::float8, ${customer.lat}::float8), ${sql.raw(String(GEO_SRID))})::geography`;
}

/** Asia/Kathmandu minute of the week now (0 = Sunday 00:00), on the database clock. */
const NOW_MINUTE_OF_WEEK = sql`(
  extract(dow FROM now() AT TIME ZONE 'Asia/Kathmandu')::int * 1440
  + extract(hour FROM now() AT TIME ZONE 'Asia/Kathmandu')::int * 60
  + extract(minute FROM now() AT TIME ZONE 'Asia/Kathmandu')::int)`;

/**
 * Step 7.3 (SPEC core 11): why a vendor takes no order now, as one SQL expression over `vendors`
 * ('AUTO_PAUSED', 'OVERRIDE', 'HOURS'), or NULL when it is open. Derived on every read from the
 * clock: nothing is written at opening or closing time. In order:
 *   - an auto-paused shop is closed until its vendor resumes;
 *   - a running override (OPEN / CLOSED until its end, or indefinitely) wins over the hours;
 *   - a shop without hours is open;
 *   - otherwise it is open inside a range that still has at least
 *     platform_settings.last_order_minutes_before_close minutes to run (checkout stops then).
 * A range is [start, start + length) minutes of the circular week; one past midnight wraps.
 */
export function closedReason(): SQL<ShopClosedReason | null> {
  // Qualified by hand: in a single-table select Drizzle prints ${vendors.id} as a bare "id",
  // which inside these subqueries would bind to vendor_opening_hours.id (STATE_HANDOFF §8Z.33).
  const vendorId = sql.raw('"vendors"."id"');
  const running = sql`(${vendors.availability_override_until} IS NULL OR ${vendors.availability_override_until} > now())`;
  return sql<ShopClosedReason | null>`(CASE
    WHEN ${vendors.auto_paused_at} IS NOT NULL THEN 'AUTO_PAUSED'
    WHEN ${vendors.availability_override} = 'OPEN' AND ${running} THEN NULL
    WHEN ${vendors.availability_override} = 'CLOSED' AND ${running} THEN 'OVERRIDE'
    WHEN NOT EXISTS (SELECT 1 FROM vendor_opening_hours h WHERE h.vendor_id = ${vendorId}) THEN NULL
    WHEN EXISTS (
      SELECT 1 FROM vendor_opening_hours h,
        LATERAL (SELECT
          h.weekday * 1440 + (extract(epoch FROM h.opens_at) / 60)::int AS start,
          (((extract(epoch FROM h.closes_at) - extract(epoch FROM h.opens_at)) / 60)::int + 1440) % 1440 AS length
        ) r
      WHERE h.vendor_id = ${vendorId}
        AND (${NOW_MINUTE_OF_WEEK} - r.start + 10080) % 10080
            < r.length - (SELECT last_order_minutes_before_close FROM platform_settings)
    ) THEN NULL
    ELSE 'HOURS'
  END)`;
}

/**
 * Whether a vendor's own delivery mode is switched on, as one SQL expression over `vendors`.
 * Derived on every read: nothing is stored per vendor for a switched-off mode.
 */
export function modeEnabled(modes: readonly VendorFulfillmentMode[]): SQL<boolean> {
  if (modes.length === 0) return sql<boolean>`false`;
  return sql<boolean>`(${inArray(vendors.fulfillment_mode, [...modes])})`;
}

/**
 * Whether a vendor delivers to a point (SPEC §2, Delivery Modularity), as one SQL expression over
 * `vendors`. The feed, the menu and checkout all use it, so they cannot disagree:
 *
 *   the shop's delivery mode is one the Super Admin has enabled (else it is forced Offline), and
 *   NATION_WIDE   anywhere
 *   CITY_WIDE     the customer's Palika is one the shop lists (no Palika given: never)
 *   RADIUS_BOUND  within radius_km x 1.1 (the GPS drift buffer), metre-accurate
 */
export function deliversTo(
  customer: DeliveryPoint,
  modes: readonly VendorFulfillmentMode[],
): SQL<boolean> {
  if (modes.length === 0) return sql<boolean>`false`;
  const palika = customer.municipality_palika_string;
  return sql<boolean>`(${inArray(vendors.fulfillment_mode, [...modes])} AND CASE ${vendors.delivery_scope}
          WHEN 'NATION_WIDE' THEN true
          WHEN 'CITY_WIDE' THEN ${palika === undefined ? sql`false` : sql`${palika}::text = ANY (${vendors.serviceable_palikas})`}
          ELSE ST_DWithin(
            ${vendors.location}::geography,
            ${customerPoint(customer)},
            ${vendors.radius_km} * 1000 * ${sql.raw(String(DELIVERY_RADIUS_GPS_DRIFT_MULTIPLIER))}
          )
        END)`;
}

/** The delivery modes the Super Admin has switched on. Empty: the global Emergency Stop. */
export async function enabledModes(db: Executor): Promise<VendorFulfillmentMode[]> {
  const [settings] = await db
    .select({
      self: platformSettings.self_delivery_enabled,
      fleet: platformSettings.platform_fleet_enabled,
    })
    .from(platformSettings);
  if (settings === undefined) throw new Error('platform_settings row is missing');
  return [
    ...(settings.self ? (['SELF_DELIVERY'] as const) : []),
    ...(settings.fleet ? (['PLATFORM_FLEET'] as const) : []),
  ];
}

function toCatalogVendor(row: {
  id: string;
  business_name: string;
  delivery_scope: CatalogVendor['deliveryScope'];
  radius_km: number;
  municipality_palika_string: string;
  min_order_value: number;
  base_delivery_fee_npr: number;
  free_delivery_above_npr: number | null;
  fulfillment_mode: VendorFulfillmentMode;
  location: GeoPoint;
  distance_m: number;
  serviceable: boolean;
  delivery_available: boolean;
  closed_reason: ShopClosedReason | null;
}): CatalogVendor {
  return {
    id: row.id,
    businessName: row.business_name,
    deliveryScope: row.delivery_scope,
    radiusKm: row.radius_km,
    municipalityPalika: row.municipality_palika_string,
    minOrderValue: row.min_order_value,
    baseDeliveryFee: row.base_delivery_fee_npr,
    // The platform's charge has no threshold: a fleet shop's stored one (always null) is not shown.
    freeDeliveryAboveNpr:
      row.fulfillment_mode === 'SELF_DELIVERY' ? row.free_delivery_above_npr : null,
    fulfillmentMode: row.fulfillment_mode,
    location: row.location,
    distanceM: row.distance_m,
    serviceable: row.serviceable,
    deliveryAvailable: row.delivery_available,
    closedReason: row.closed_reason,
  };
}
