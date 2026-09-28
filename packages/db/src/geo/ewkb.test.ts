import { parseHexEwkbPoint, toEwktPoint } from './ewkb';

// Produced by PostGIS: SELECT ST_SetSRID(ST_MakePoint(85.3123, 27.7154), 4326);
const THAMEL_EWKB_LE = '0101000020E61000009CA223B9FC535540F38E537424B73B40';

describe('parseHexEwkbPoint', () => {
  it('parses a little-endian EWKB point with SRID', () => {
    const { point, srid } = parseHexEwkbPoint(THAMEL_EWKB_LE);

    expect(srid).toBe(4326);
    expect(point.x).toBeCloseTo(85.3123, 10);
    expect(point.y).toBeCloseTo(27.7154, 10);
  });

  it('parses a big-endian WKB point without SRID', () => {
    const buf = Buffer.alloc(21);
    buf.writeUInt8(0, 0);
    buf.writeUInt32BE(1, 1);
    buf.writeDoubleBE(85.43, 5);
    buf.writeDoubleBE(27.67, 13);

    expect(parseHexEwkbPoint(buf.toString('hex'))).toEqual({
      point: { x: 85.43, y: 27.67 },
      srid: null,
    });
  });

  it('rejects non-point geometries', () => {
    // LINESTRING type word (2) with SRID flag.
    expect(() => parseHexEwkbPoint('0102000020E6100000' + '00'.repeat(36))).toThrow(
      'expected Point',
    );
  });

  it('rejects 3D points', () => {
    expect(() => parseHexEwkbPoint('01010000A0E6100000' + '00'.repeat(24))).toThrow('2D');
  });

  it('rejects malformed hex', () => {
    expect(() => parseHexEwkbPoint('xyz')).toThrow('hex');
    expect(() => parseHexEwkbPoint('0101')).toThrow('too short');
  });
});

describe('toEwktPoint', () => {
  it('serialises lng/lat with the SRID prefix', () => {
    expect(toEwktPoint({ x: 85.3123, y: 27.7154 }, 4326)).toBe('SRID=4326;POINT(85.3123 27.7154)');
  });

  it('rejects non-finite coordinates', () => {
    expect(() => toEwktPoint({ x: Number.NaN, y: 27 }, 4326)).toThrow('finite');
    expect(() => toEwktPoint({ x: 85, y: Number.POSITIVE_INFINITY }, 4326)).toThrow('finite');
  });
});
