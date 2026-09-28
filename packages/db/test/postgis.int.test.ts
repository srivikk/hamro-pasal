import type { Pool } from 'pg';

import {
  createTestPool,
  createUser,
  createVendor,
  firstRow,
  pgError,
  THAMEL,
} from './support/fixtures';

/**
 * SPEC §2 serviceability for RADIUS_BOUND vendors: distance <= radius_km * 1.1 (10% GPS grace).
 * Vendors are placed at exact geodesic distances from the customer using ST_Project.
 */
const SERVICEABLE_RADIUS_SQL = `
  SELECT v.id, ST_Distance(v.location::geography, c.pt) AS distance_m
  FROM vendors v,
       LATERAL (SELECT ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography AS pt) c
  WHERE v.id = ANY($3::uuid[])
    AND v.delivery_scope = 'RADIUS_BOUND'
    AND ST_DWithin(v.location::geography, c.pt, v.radius_km * 1000 * 1.1)
  ORDER BY distance_m`;

describe('PostGIS', () => {
  let pool: Pool;

  beforeAll(() => {
    pool = createTestPool();
  });

  afterAll(async () => {
    await pool.end();
  });

  async function vendorAtDistance(
    distanceM: number,
    azimuthDeg: number,
    radiusKm = 5,
  ): Promise<string> {
    const { rows } = await pool.query<{ lng: number; lat: number }>(
      `SELECT ST_X(p::geometry) AS lng, ST_Y(p::geometry) AS lat
       FROM ST_Project(ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography, $3::float8, radians($4)) AS p`,
      [THAMEL.lng, THAMEL.lat, distanceM, azimuthDeg],
    );
    const { lng, lat } = firstRow(rows);
    return createVendor(pool, { radiusKm, lng, lat });
  }

  it('declares vendor and address locations as geometry(Point, 4326)', async () => {
    const { rows } = await pool.query<{ f_table_name: string; type: string; srid: number }>(
      `SELECT f_table_name, type, srid FROM geometry_columns
       WHERE f_geometry_column = 'location' ORDER BY f_table_name`,
    );

    expect(rows).toEqual([
      { f_table_name: 'customer_addresses', type: 'POINT', srid: 4326 },
      { f_table_name: 'vendors', type: 'POINT', srid: 4326 },
    ]);
  });

  describe('typed geometry column', () => {
    const insertVendorWith = async (geom: string) =>
      pool.query<{ srid: number }>(
        `INSERT INTO vendors (user_id, business_name, phone, commission_rate, delivery_scope,
                              radius_km, city_string, min_order_value, base_delivery_fee_npr, location)
         VALUES ($1, 'X', '+9779811111111', 0.1, 'RADIUS_BOUND', 5, 'Kathmandu', 0, 0, ${geom})
         RETURNING ST_SRID(location) AS srid`,
        [await createUser(pool, 'VENDOR')],
      );

    it('rejects a point in a different SRID', async () => {
      // Web Mercator coordinates of Thamel.
      const error = await pgError(
        insertVendorWith(`ST_SetSRID(ST_MakePoint(9497000, 3212000), 3857)`),
      );

      expect(error.message).toMatch(/SRID \(3857\) does not match column SRID \(4326\)/);
    });

    it('rejects non-point geometries', async () => {
      const error = await pgError(
        insertVendorWith(
          `ST_SetSRID(ST_MakeLine(ST_MakePoint(85.3, 27.7), ST_MakePoint(85.4, 27.8)), 4326)`,
        ),
      );

      expect(error.message).toMatch(/type \(LineString\) does not match column type \(Point\)/);
    });

    it('stamps SRID-less (unknown, 0) points with the column SRID', async () => {
      const { rows } = await insertVendorWith(`ST_MakePoint(85.3, 27.7)`);

      expect(firstRow(rows).srid).toBe(4326);
    });
  });

  it('finds RADIUS_BOUND vendors within radius x 1.1 and excludes those beyond it', async () => {
    const near = await vendorAtDistance(1_000, 0);
    const insideGrace = await vendorAtDistance(5_450, 90); // 5 km radius -> 5.5 km with buffer
    const outsideGrace = await vendorAtDistance(5_550, 180);
    const farAway = await vendorAtDistance(12_000, 270);
    const cityWide = await createVendor(pool, { deliveryScope: 'CITY_WIDE' });

    const { rows } = await pool.query<{ id: string; distance_m: number }>(SERVICEABLE_RADIUS_SQL, [
      THAMEL.lng,
      THAMEL.lat,
      [near, insideGrace, outsideGrace, farAway, cityWide],
    ]);

    expect(rows.map((r) => r.id)).toEqual([near, insideGrace]);
    expect(firstRow(rows).distance_m).toBeCloseTo(1_000, 0);
    expect(rows[1]?.distance_m).toBeCloseTo(5_450, 0);
  });

  it('respects each vendor’s own radius', async () => {
    const smallRadius = await vendorAtDistance(2_500, 45, 2); // 2.2 km reach
    const largeRadius = await vendorAtDistance(2_500, 225, 3); // 3.3 km reach

    const { rows } = await pool.query<{ id: string }>(SERVICEABLE_RADIUS_SQL, [
      THAMEL.lng,
      THAMEL.lat,
      [smallRadius, largeRadius],
    ]);

    expect(rows.map((r) => r.id)).toEqual([largeRadius]);
  });

  it('serves fixed-distance radius searches from the geography GiST index', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL enable_seqscan = off');
      const { rows } = await client.query<{ 'QUERY PLAN': string }>(
        `EXPLAIN SELECT id FROM vendors
         WHERE ST_DWithin(location::geography, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography, 3000)`,
        [THAMEL.lng, THAMEL.lat],
      );
      const plan = rows.map((r) => r['QUERY PLAN']).join('\n');
      expect(plan).toContain('vendors_location_geography_gist');
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('serves bounding-box searches from the geometry GiST indexes', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL enable_seqscan = off');
      for (const [table, index] of [
        ['vendors', 'vendors_location_gist'],
        ['customer_addresses', 'customer_addresses_location_gist'],
      ] as const) {
        const { rows } = await client.query<{ 'QUERY PLAN': string }>(
          `EXPLAIN SELECT id FROM ${table}
           WHERE location && ST_MakeEnvelope(85.2, 27.6, 85.5, 27.8, 4326)`,
        );
        expect(rows.map((r) => r['QUERY PLAN']).join('\n')).toContain(index);
      }
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('derives customer address geometry from exact_lat/exact_lng and keeps it in sync', async () => {
    const userId = await createUser(pool);
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO customer_addresses (user_id, province_id, district_string, municipality_palika_string,
                                       ward_number, tole_locality, landmark, exact_lat, exact_lng)
       VALUES ($1, 3, 'Kathmandu', 'Kathmandu Metropolitan City', 26, 'Thamel', 'Near Garden of Dreams',
               27.7149, 85.3106)
       RETURNING id`,
      [userId],
    );
    const addressId = firstRow(rows).id;
    const locationOf = async () =>
      firstRow(
        (
          await pool.query<{ lng: number; lat: number; srid: number }>(
            `SELECT ST_X(location) AS lng, ST_Y(location) AS lat, ST_SRID(location) AS srid
             FROM customer_addresses WHERE id = $1`,
            [addressId],
          )
        ).rows,
      );

    expect(await locationOf()).toEqual({ lng: 85.3106, lat: 27.7149, srid: 4326 });

    await pool.query(
      'UPDATE customer_addresses SET exact_lat = 27.6784, exact_lng = 85.3188 WHERE id = $1',
      [addressId],
    );
    expect(await locationOf()).toEqual({ lng: 85.3188, lat: 27.6784, srid: 4326 });

    const direct = await pgError(
      pool.query(
        `UPDATE customer_addresses SET location = ST_SetSRID(ST_MakePoint(0, 0), 4326) WHERE id = $1`,
        [addressId],
      ),
    );
    expect(direct.message).toMatch(/can only be updated to DEFAULT/);
  });
});
