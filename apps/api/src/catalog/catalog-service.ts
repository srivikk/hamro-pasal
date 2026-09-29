import { products, vendors, type Database } from '@hamro-pasal/db';
import {
  DELIVERY_RADIUS_GPS_DRIFT_MULTIPLIER,
  GEO_SRID,
  type GeoPoint,
  type VendorFeedQuery,
  type VendorFulfillmentMode,
} from '@hamro-pasal/shared-types';
import { and, asc, eq, sql, type SQL } from 'drizzle-orm';

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
}

export interface VendorFeed {
  readonly serviceable: readonly CatalogVendor[];
  readonly unserviceable: readonly CatalogVendor[];
}

export interface MenuProduct {
  readonly id: string;
  readonly name: string;
  readonly priceNpr: number;
  readonly inStock: boolean;
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
    const rows = await this.db
      .select(this.vendorColumns(customer))
      .from(vendors)
      .where(eq(vendors.status, 'LIVE'))
      .orderBy(sql`distance_m`, asc(vendors.id));

    const all = rows.map(toCatalogVendor);
    return {
      serviceable: all.filter((v) => v.serviceable).slice(0, FEED_SECTION_LIMIT),
      unserviceable: all.filter((v) => !v.serviceable).slice(0, FEED_SECTION_LIMIT),
    };
  }

  /** GET /api/vendors/:id/products: a LIVE vendor's active catalogue with real product ids. */
  async getMenu(vendorId: string, customer: VendorFeedQuery): Promise<VendorMenu> {
    const [row] = await this.db
      .select(this.vendorColumns(customer))
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
      })),
    };
  }

  private vendorColumns(customer: VendorFeedQuery) {
    const point = sql`ST_SetSRID(ST_MakePoint(${customer.lng}::float8, ${customer.lat}::float8), ${sql.raw(String(GEO_SRID))})::geography`;
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
      distance_m: sql<number>`ST_Distance(${vendors.location}::geography, ${point})`
        .mapWith(Number)
        .as('distance_m'),
      serviceable: sql<boolean>`CASE ${vendors.delivery_scope}
          WHEN 'NATION_WIDE' THEN true
          WHEN 'CITY_WIDE' THEN ${cityMatch(customer.municipality_palika_string)}
          ELSE ST_DWithin(
            ${vendors.location}::geography,
            ${point},
            ${vendors.radius_km} * 1000 * ${sql.raw(String(DELIVERY_RADIUS_GPS_DRIFT_MULTIPLIER))}
          )
        END`
        .mapWith(Boolean)
        .as('serviceable'),
    };
  }
}

/** CITY_WIDE: exact Palika match, as stored on both sides. No Palika given: never serviceable. */
function cityMatch(palika: string | undefined): SQL {
  return palika === undefined
    ? sql`false`
    : sql`${vendors.municipality_palika_string} = ${palika}::text`;
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
  };
}
