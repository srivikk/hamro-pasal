import { distanceKm, GPS_DRIFT_BUFFER, isServiceable } from './serviceability';

const KATHMANDU = 'Kathmandu Metropolitan City';
const LALITPUR = 'Lalitpur Metropolitan City';

describe('distanceKm', () => {
  it('is zero for the same point', () => {
    expect(distanceKm({ x: 85.3123, y: 27.7154 }, { x: 85.3123, y: 27.7154 })).toBe(0);
  });

  it('measures one degree of latitude as ~111.2 km', () => {
    expect(distanceKm({ x: 85, y: 27 }, { x: 85, y: 28 })).toBeCloseTo(111.195, 2);
  });

  it('is symmetric and matches Thamel to Pokhara (~140 km)', () => {
    const thamel = { x: 85.3123, y: 27.7154 };
    const pokhara = { x: 83.9856, y: 28.2096 };

    expect(distanceKm(thamel, pokhara)).toBeCloseTo(distanceKm(pokhara, thamel), 9);
    expect(distanceKm(thamel, pokhara)).toBeGreaterThan(135);
    expect(distanceKm(thamel, pokhara)).toBeLessThan(145);
  });
});

describe('isServiceable (SPEC §2)', () => {
  const radiusVendor = {
    delivery_scope: 'RADIUS_BOUND',
    radius_km: 5,
    municipality_palika_string: KATHMANDU,
  } as const;

  it('uses a 10% GPS drift buffer', () => {
    expect(GPS_DRIFT_BUFFER).toBe(1.1);
  });

  it.each([
    [0, true],
    [5, true],
    [5.3, true],
    [5.5, true],
    [5.5001, false],
    [40, false],
  ])('RADIUS_BOUND 5 km at %p km -> %p', (distance, expected) => {
    expect(isServiceable(radiusVendor, KATHMANDU, distance)).toBe(expected);
  });

  it('RADIUS_BOUND ignores the Palika', () => {
    expect(isServiceable(radiusVendor, LALITPUR, 1)).toBe(true);
  });

  it('CITY_WIDE serves the same Palika at any distance', () => {
    const vendor = {
      delivery_scope: 'CITY_WIDE',
      radius_km: 1,
      municipality_palika_string: LALITPUR,
    } as const;

    expect(isServiceable(vendor, LALITPUR, 50)).toBe(true);
    expect(isServiceable(vendor, KATHMANDU, 0.1)).toBe(false);
  });

  it('CITY_WIDE requires an exact Palika match, like the server SQL', () => {
    const vendor = {
      delivery_scope: 'CITY_WIDE',
      radius_km: 1,
      municipality_palika_string: LALITPUR,
    } as const;

    expect(isServiceable(vendor, 'lalitpur metropolitan city', 1)).toBe(false);
  });

  it('NATION_WIDE serves everyone', () => {
    const vendor = {
      delivery_scope: 'NATION_WIDE',
      radius_km: 1,
      municipality_palika_string: LALITPUR,
    } as const;

    expect(isServiceable(vendor, KATHMANDU, 700)).toBe(true);
  });
});
