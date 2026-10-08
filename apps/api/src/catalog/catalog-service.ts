import { platformSettings, products, vendors, type Database, type Executor } from '@hamro-pasal/db';
import {
  DELIVERY_RADIUS_GPS_DRIFT_MULTIPLIER,
  GEO_SRID,
  type GeoPoint,
  type VendorFeedQuery,
  type VendorFulfillmentMode,
} from '@hamro-pasal/shared-types';
import { and, asc, eq, inArray, sql, type SQL } from 'drizzle-orm';

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
  readonly fulfillmentMode: VendorFulfillmentMode;
  readonly location: GeoPoint;
  /** Geodesic distance from the customer (WGS 84 spheroid), in metres. */
  readonly distanceM: number;
  readonly serviceable: boolean;
  /** The shop's delivery mode is one the Super Admin has switched on (else it is forced Offline). */
  readonly deliveryAvailable: boolean;
}

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
    return {
      serviceable: all.filter((v) => v.serviceable).slice(0, FEED_SECTION_LIMIT),
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

  private vendorColumns(customer: VendorFeedQuery, modes: readonly VendorFulfillmentMode[]) {
    return {
      id: vendors.id,
      business_name: vendors.business_name,
      delivery_scope: vendors.delivery_scope,
      radius_km: vendors.radius_km,
      municipality_palika_string: vendors.municipality_palika_string,
      min_order_value: vendors.min_order_value,
      base_delivery_fee_npr: vendors.base_delivery_fee_npr,
      fulfillment_mode: vendors.fulfillment_mode,
      location: vendors.location,
      distance_m:
        sql<number>`ST_Distance(${vendors.location}::geography, ${customerPoint(customer)})`
          .mapWith(Number)
          .as('distance_m'),
      serviceable: deliversTo(customer, modes).mapWith(Boolean).as('serviceable'),
      delivery_available: modeEnabled(modes).mapWith(Boolean).as('delivery_available'),
    };
  }
}

export interface DeliveryPoint {
  readonly lat: number;
  readonly lng: number;
  readonly municipality_palika_string?: string | undefined;
}

function customerPoint(customer: DeliveryPoint): SQL {
  return sql`ST_SetSRID(ST_MakePoint(${customer.lng}::float8, ${customer.lat}::float8), ${sql.raw(String(GEO_SRID))})::geography`;
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
  fulfillment_mode: VendorFulfillmentMode;
  location: GeoPoint;
  distance_m: number;
  serviceable: boolean;
  delivery_available: boolean;
}): CatalogVendor {
  return {
    id: row.id,
    businessName: row.business_name,
    deliveryScope: row.delivery_scope,
    radiusKm: row.radius_km,
    municipalityPalika: row.municipality_palika_string,
    minOrderValue: row.min_order_value,
    baseDeliveryFee: row.base_delivery_fee_npr,
    fulfillmentMode: row.fulfillment_mode,
    location: row.location,
    distanceM: row.distance_m,
    serviceable: row.serviceable,
    deliveryAvailable: row.delivery_available,
  };
}
