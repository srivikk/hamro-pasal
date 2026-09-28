import type { GeoPoint } from '@hamro-pasal/shared-types';

const WKB_POINT = 1;
const EWKB_SRID_FLAG = 0x20000000;
const EWKB_Z_FLAG = 0x80000000;
const EWKB_M_FLAG = 0x40000000;

export interface ParsedPoint {
  readonly point: GeoPoint;
  readonly srid: number | null;
}

/**
 * Parses a PostGIS hex-encoded (E)WKB 2D point, which is how `geometry` values arrive from `pg`.
 * Throws on anything other than a 2D Point, so a wrong geometry type is caught instead of misread.
 */
export function parseHexEwkbPoint(hex: string): ParsedPoint {
  if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length % 2 !== 0) {
    throw new Error('Invalid EWKB: expected an even-length hex string');
  }
  const bytes = Buffer.from(hex, 'hex');
  if (bytes.length < 21) {
    throw new Error('Invalid EWKB: too short for a point');
  }

  const littleEndian = bytes.readUInt8(0) === 1;
  const readUInt32 = (offset: number): number =>
    littleEndian ? bytes.readUInt32LE(offset) : bytes.readUInt32BE(offset);
  const readDouble = (offset: number): number =>
    littleEndian ? bytes.readDoubleLE(offset) : bytes.readDoubleBE(offset);

  const typeWord = readUInt32(1);
  if ((typeWord & (EWKB_Z_FLAG | EWKB_M_FLAG)) !== 0) {
    throw new Error('Invalid EWKB: only 2D points are supported');
  }
  if ((typeWord & 0xff) !== WKB_POINT) {
    throw new Error(`Invalid EWKB: expected Point, got geometry type ${String(typeWord & 0xff)}`);
  }

  const hasSrid = (typeWord & EWKB_SRID_FLAG) !== 0;
  const coordsOffset = hasSrid ? 9 : 5;
  if (bytes.length !== coordsOffset + 16) {
    throw new Error('Invalid EWKB: unexpected length for a 2D point');
  }

  return {
    point: { x: readDouble(coordsOffset), y: readDouble(coordsOffset + 8) },
    srid: hasSrid ? readUInt32(5) : null,
  };
}

/** Serialises a point as EWKT, which PostGIS accepts as text input for typed geometry columns. */
export function toEwktPoint(point: GeoPoint, srid: number): string {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
    throw new Error('Point coordinates must be finite numbers');
  }
  return `SRID=${String(srid)};POINT(${String(point.x)} ${String(point.y)})`;
}
