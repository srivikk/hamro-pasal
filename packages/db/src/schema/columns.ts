import { GEO_SRID, type GeoPoint } from '@hamro-pasal/shared-types';
import { customType, numeric, timestamp, uuid } from 'drizzle-orm/pg-core';

import { parseHexEwkbPoint, toEwktPoint } from '../geo/ewkb';

export const primaryId = () => uuid().primaryKey().defaultRandom();

export const createdAt = () =>
  timestamp({ withTimezone: true, mode: 'date' }).notNull().defaultNow();

/** Kept current by the `set_updated_at` trigger (see the triggers migration). */
export const updatedAt = () =>
  timestamp({ withTimezone: true, mode: 'date' }).notNull().defaultNow();

/** NPR with paisa precision. Returned as a JS number (SPEC types money as `number`). */
export const npr = () => numeric({ precision: 12, scale: 2, mode: 'number' });

/**
 * PostGIS `geometry(Point, 4326)`, read and written as `{ x: lng, y: lat }`.
 * Drizzle's built-in `geometry()` ignores `srid` (it emits `geometry(point)` and writes SRID-less
 * WKT), so this custom type declares the typmod explicitly and writes EWKT.
 */
export const geoPoint = customType<{ data: GeoPoint; driverData: string }>({
  dataType: () => `geometry(Point,${String(GEO_SRID)})`,
  toDriver: (point) => toEwktPoint(point, GEO_SRID),
  fromDriver: (hex) => {
    const { point, srid } = parseHexEwkbPoint(hex);
    if (srid !== GEO_SRID) {
      throw new Error(`Expected SRID ${String(GEO_SRID)}, got ${String(srid)}`);
    }
    return point;
  },
});
