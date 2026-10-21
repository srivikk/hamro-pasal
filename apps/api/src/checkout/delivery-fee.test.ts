import {
  deliveryCharge,
  freeDeliveryThresholdNpr,
  haversineKm,
  type DeliveryTerms,
} from './delivery-fee';

const self: DeliveryTerms = {
  fulfillmentMode: 'SELF_DELIVERY',
  deliveryScope: 'RADIUS_BOUND',
  baseFeeNpr: 40,
  perKmFeeNpr: 10,
  freeAboveNpr: 1500,
  platformFeeNpr: 50,
  platformFreeAboveNpr: null,
};
const fleet: DeliveryTerms = { ...self, fulfillmentMode: 'PLATFORM_FLEET' };

/** What the customer pays for delivery. */
const feeOf = (terms: DeliveryTerms, goodsPaisa: number, km: number): number =>
  deliveryCharge(terms, goodsPaisa, km).feePaisa;

describe('haversineKm', () => {
  it('measures Thamel to Patan Durbar Square at about 4.9 km, and 0 to itself', () => {
    const thamel = { x: 85.3123, y: 27.7154 };
    const patan = { x: 85.3249, y: 27.6727 };
    expect(haversineKm(thamel, patan)).toBeCloseTo(4.91, 1);
    expect(haversineKm(patan, thamel)).toBeCloseTo(haversineKm(thamel, patan), 9);
    expect(haversineKm(thamel, thamel)).toBe(0);
  });
});

describe('deliveryCharge', () => {
  it('charges base + per-km for each started kilometre', () => {
    expect(feeOf(self, 100_000, 0)).toBe(4_000);
    expect(feeOf(self, 100_000, 0.2)).toBe(5_000);
    expect(feeOf(self, 100_000, 3)).toBe(7_000);
    expect(feeOf(self, 100_000, 3.01)).toBe(8_000);
  });

  it("is free at or above the shop's threshold, funded by the shop, and charged one paisa below", () => {
    expect(deliveryCharge(self, 150_000, 3)).toEqual({
      feePaisa: 0,
      subsidyPaisa: 0,
      freeBy: 'SHOP',
    });
    expect(deliveryCharge(self, 149_999, 3)).toEqual({
      feePaisa: 7_000,
      subsidyPaisa: 0,
      freeBy: null,
    });
    expect(feeOf({ ...self, freeAboveNpr: null }, 9_999_999, 3)).toBe(7_000);
  });

  it('charges 0 for a shop with no fee configured', () => {
    expect(feeOf({ ...self, baseFeeNpr: 0, perKmFeeNpr: 0, freeAboveNpr: null }, 100_000, 4)).toBe(
      0,
    );
  });

  it('applies the per-km fee to the radius tier only', () => {
    expect(feeOf({ ...self, deliveryScope: 'CITY_WIDE' }, 100_000, 12)).toBe(4_000);
    expect(feeOf({ ...self, deliveryScope: 'NATION_WIDE' }, 100_000, 400)).toBe(4_000);
  });

  it("charges the platform fee for a fleet delivery, whatever the shop's own threshold", () => {
    expect(feeOf(fleet, 100_000, 3)).toBe(5_000);
    expect(feeOf(fleet, 900_000, 30)).toBe(5_000);
    expect(feeOf({ ...fleet, platformFeeNpr: 0 }, 100_000, 3)).toBe(0);
  });

  it('is free from the moment the goods reach the platform threshold, funded by the platform', () => {
    const terms = { ...fleet, platformFreeAboveNpr: 100 };
    expect(deliveryCharge(terms, 9_999, 3)).toEqual({
      feePaisa: 5_000,
      subsidyPaisa: 0,
      freeBy: null,
    });
    expect(deliveryCharge(terms, 10_000, 3)).toEqual({
      feePaisa: 0,
      subsidyPaisa: 5_000,
      freeBy: 'PLATFORM',
    });
  });

  it('pays a self-delivering shop its own fee under the platform threshold, never charging it', () => {
    const terms = { ...self, platformFreeAboveNpr: 100 };
    // Below the shop's 1500 but above the platform's 100: the platform pays the shop's 70.
    expect(deliveryCharge(terms, 50_000, 3)).toEqual({
      feePaisa: 0,
      subsidyPaisa: 7_000,
      freeBy: 'PLATFORM',
    });
    // The shop's own threshold reached: the shop forgoes its fee, as it chose; no subsidy.
    expect(deliveryCharge(terms, 150_000, 3)).toEqual({
      feePaisa: 0,
      subsidyPaisa: 0,
      freeBy: 'SHOP',
    });
  });

  it('subsidises nothing when there is no fee to pay', () => {
    expect(
      deliveryCharge({ ...fleet, platformFeeNpr: 0, platformFreeAboveNpr: 100 }, 50_000, 3),
    ).toEqual({ feePaisa: 0, subsidyPaisa: 0, freeBy: null });
  });

  it('multiplies a per-km fee in decimal: 0.1 NPR per km over 3 km is exactly 30 paisa', () => {
    expect(feeOf({ ...self, baseFeeNpr: 0, perKmFeeNpr: 0.1, freeAboveNpr: null }, 0, 2.5)).toBe(
      30,
    );
  });
});

describe('freeDeliveryThresholdNpr', () => {
  it("shows the lowest threshold that applies: the shop's on self delivery, the platform's for all", () => {
    expect(freeDeliveryThresholdNpr(self)).toBe(1500);
    expect(freeDeliveryThresholdNpr({ ...self, platformFreeAboveNpr: 100 })).toBe(100);
    expect(freeDeliveryThresholdNpr({ ...self, platformFreeAboveNpr: 2000 })).toBe(1500);
    expect(freeDeliveryThresholdNpr(fleet)).toBeNull();
    expect(freeDeliveryThresholdNpr({ ...fleet, platformFreeAboveNpr: 100 })).toBe(100);
  });
});
