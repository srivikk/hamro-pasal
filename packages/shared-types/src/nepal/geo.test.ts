import { nepalAddressInputSchema } from '../localization/address';
import { isWithinNepalBoundingBox, NEPAL_BOUNDING_BOX } from './geo';

const thamel = {
  province_id: 3,
  district_string: 'Kathmandu',
  municipality_palika_string: 'Kathmandu Metropolitan City',
  ward_number: 26,
  tole_locality: 'Thamel',
  landmark: 'Near Kathmandu Guest House',
  exact_lat: 27.7149,
  exact_lng: 85.3106,
};

describe('NEPAL_BOUNDING_BOX', () => {
  it("is Nepal's extreme points", () => {
    expect(NEPAL_BOUNDING_BOX).toEqual({
      minLat: 26.347,
      maxLat: 30.447,
      minLng: 80.058,
      maxLng: 88.201,
    });
  });

  it('includes its edges and excludes anything beyond them', () => {
    const { minLat, maxLat, minLng, maxLng } = NEPAL_BOUNDING_BOX;

    expect(isWithinNepalBoundingBox({ lat: minLat, lng: minLng })).toBe(true);
    expect(isWithinNepalBoundingBox({ lat: maxLat, lng: maxLng })).toBe(true);
    expect(isWithinNepalBoundingBox({ lat: 27.7149, lng: 85.3106 })).toBe(true);
    expect(isWithinNepalBoundingBox({ lat: minLat - 0.001, lng: 85 })).toBe(false);
    expect(isWithinNepalBoundingBox({ lat: maxLat + 0.001, lng: 85 })).toBe(false);
    expect(isWithinNepalBoundingBox({ lat: 28, lng: minLng - 0.001 })).toBe(false);
    expect(isWithinNepalBoundingBox({ lat: 28, lng: maxLng + 0.001 })).toBe(false);
    expect(isWithinNepalBoundingBox({ lat: Number.NaN, lng: 85 })).toBe(false);
  });

  it('is the box the address pin validation uses', () => {
    const { minLat, maxLat, minLng, maxLng } = NEPAL_BOUNDING_BOX;
    const pin = (exact_lat: number, exact_lng: number) =>
      nepalAddressInputSchema.safeParse({ ...thamel, exact_lat, exact_lng }).success;

    expect(pin(minLat, minLng)).toBe(true);
    expect(pin(maxLat, maxLng)).toBe(true);
    expect(pin(minLat - 0.001, 85)).toBe(false);
    expect(pin(28, maxLng + 0.001)).toBe(false);
  });
});
