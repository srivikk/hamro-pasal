import { deliveryFeePaisa, haversineKm, type DeliveryTerms } from './delivery-fee';

const self: DeliveryTerms = {
  fulfillmentMode: 'SELF_DELIVERY',
  deliveryScope: 'RADIUS_BOUND',
  baseFeeNpr: 40,
  perKmFeeNpr: 10,
  freeAboveNpr: 1500,
  platformFeeNpr: 50,
};

describe('haversineKm', () => {
  it('measures Thamel to Patan Durbar Square at about 4.9 km, and 0 to itself', () => {
    const thamel = { x: 85.3123, y: 27.7154 };
    const patan = { x: 85.3249, y: 27.6727 };
    expect(haversineKm(thamel, patan)).toBeCloseTo(4.91, 1);
    expect(haversineKm(patan, thamel)).toBeCloseTo(haversineKm(thamel, patan), 9);
    expect(haversineKm(thamel, thamel)).toBe(0);
  });
});

describe('deliveryFeePaisa', () => {
  it('charges base + per-km for each started kilometre', () => {
    expect(deliveryFeePaisa(self, 100_000, 0)).toBe(4_000);
    expect(deliveryFeePaisa(self, 100_000, 0.2)).toBe(5_000);
    expect(deliveryFeePaisa(self, 100_000, 3)).toBe(7_000);
    expect(deliveryFeePaisa(self, 100_000, 3.01)).toBe(8_000);
  });

  it('is free at or above the threshold, and charged one paisa below it', () => {
    expect(deliveryFeePaisa(self, 150_000, 3)).toBe(0);
    expect(deliveryFeePaisa(self, 149_999, 3)).toBe(7_000);
    expect(deliveryFeePaisa({ ...self, freeAboveNpr: null }, 9_999_999, 3)).toBe(7_000);
  });

  it('charges 0 for a shop with no fee configured', () => {
    expect(
      deliveryFeePaisa({ ...self, baseFeeNpr: 0, perKmFeeNpr: 0, freeAboveNpr: null }, 100_000, 4),
    ).toBe(0);
  });

  it('applies the per-km fee to the radius tier only', () => {
    expect(deliveryFeePaisa({ ...self, deliveryScope: 'CITY_WIDE' }, 100_000, 12)).toBe(4_000);
    expect(deliveryFeePaisa({ ...self, deliveryScope: 'NATION_WIDE' }, 100_000, 400)).toBe(4_000);
  });

  it('charges the platform fee for a fleet delivery, whatever the shop set or the subtotal', () => {
    const fleet = { ...self, fulfillmentMode: 'PLATFORM_FLEET' as const };
    expect(deliveryFeePaisa(fleet, 100_000, 3)).toBe(5_000);
    expect(deliveryFeePaisa(fleet, 900_000, 30)).toBe(5_000);
    expect(deliveryFeePaisa({ ...fleet, platformFeeNpr: 0 }, 100_000, 3)).toBe(0);
  });
});
