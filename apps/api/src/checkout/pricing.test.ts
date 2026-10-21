import {
  bestCampaign,
  bestVendorOffer,
  campaignDiscountPaisa,
  CheckoutRejectedError,
  priceCart,
  type CampaignOffer,
  type PricingProduct,
  type PricingVendor,
  type VendorOfferRule,
} from './pricing';
import { deliveryCharge, type DeliveryTerms } from './delivery-fee';

const vendor: PricingVendor = {
  pricing_model: 'COMMISSION',
  commission_rate: 0.1,
  min_order_value: 500,
  base_delivery_fee_npr: 50,
};

const products = new Map<string, PricingProduct>([
  ['rice', { id: 'rice', name: 'Basmati Rice 5kg', price_npr: 1150 }],
  ['tea', { id: 'tea', name: 'Ilam Tea 500g', price_npr: 450.55 }],
]);

describe('priceCart', () => {
  it('prices from catalogue prices with the vendor delivery fee and commission', () => {
    const priced = priceCart(vendor, products, [
      { productId: 'rice', quantity: 1 },
      { productId: 'tea', quantity: 2 },
    ]);

    expect(priced).toMatchObject({
      subtotalPaisa: 115_000 + 2 * 45_055,
      deliveryFeePaisa: 5_000,
      commissionPaisa: 20_511, // 10% of 205 110 paisa, rounded half-up
      totalPaisa: 205_110 + 5_000,
    });
    expect(priced.lines[1]).toEqual({
      productId: 'tea',
      productName: 'Ilam Tea 500g',
      unitPricePaisa: 45_055,
      quantity: 2,
    });
  });

  it('charges no commission to subscription vendors (SPEC §4)', () => {
    const priced = priceCart(
      { ...vendor, pricing_model: 'SUBSCRIPTION', commission_rate: 0 },
      products,
      [{ productId: 'rice', quantity: 1 }],
    );

    expect(priced.commissionPaisa).toBe(0);
  });

  it('rounds commission exactly where floating-point would drift', () => {
    const priced = priceCart({ ...vendor, commission_rate: 0.0725 }, products, [
      { productId: 'rice', quantity: 1 },
    ]);

    expect(priced.commissionPaisa).toBe(8_338); // 115 000 x 725 / 10 000 = 8 337.5 -> 8 338
  });

  it('rejects a subtotal below the vendor minimum order value', () => {
    const attempt = () => priceCart(vendor, products, [{ productId: 'tea', quantity: 1 }]);

    expect(attempt).toThrow(CheckoutRejectedError);
    expect(attempt).toThrow(/minimum of 500 NPR/);
  });

  it('accepts a subtotal exactly at the minimum', () => {
    const atMinimum = new Map([['x', { id: 'x', name: 'X', price_npr: 500 }]]);

    expect(priceCart(vendor, atMinimum, [{ productId: 'x', quantity: 1 }]).subtotalPaisa).toBe(
      50_000,
    );
  });
});

describe('platform campaign discounts (SPEC core 9)', () => {
  const offer = (overrides: Partial<CampaignOffer> = {}): CampaignOffer => ({
    campaignId: 'campaign',
    optInId: 'opt-in',
    optedInAt: new Date('2026-10-01T00:00:00Z'),
    name: 'Dashain 10%',
    kind: 'PERCENTAGE',
    value: 10,
    maxDiscountNpr: null,
    minCartNpr: 0,
    vendorSharePercent: 50,
    termsVersion: 1,
    ...overrides,
  });

  it('takes a percentage half-up to the paisa, up to its cap', () => {
    expect(campaignDiscountPaisa(offer(), 100_000)).toBe(10_000);
    // 12.5% of 333.33 is 41.66625: 41.67.
    expect(campaignDiscountPaisa(offer({ value: 12.5 }), 33_333)).toBe(4167);
    // 0.5 paisa rounds up, 0.49 down.
    expect(campaignDiscountPaisa(offer({ value: 10 }), 5)).toBe(1);
    expect(campaignDiscountPaisa(offer({ value: 10 }), 4)).toBe(0);
    expect(campaignDiscountPaisa(offer({ maxDiscountNpr: 60 }), 100_000)).toBe(6000);
    expect(campaignDiscountPaisa(offer({ maxDiscountNpr: 60 }), 50_000)).toBe(5000);
  });

  it('takes a flat amount, never more than the goods', () => {
    expect(campaignDiscountPaisa(offer({ kind: 'FLAT', value: 120 }), 100_000)).toBe(12_000);
    expect(campaignDiscountPaisa(offer({ kind: 'FLAT', value: 120 }), 9000)).toBe(9000);
    expect(campaignDiscountPaisa(offer({ value: 100 }), 9000)).toBe(9000);
  });

  it('applies from the minimum cart exactly, on the subtotal', () => {
    const minimum = offer({ minCartNpr: 1000 });
    expect(campaignDiscountPaisa(minimum, 99_999)).toBe(0);
    expect(campaignDiscountPaisa(minimum, 100_000)).toBe(10_000);
  });

  it('picks the larger discount; between equal ones, the earlier opt-in', () => {
    const small = offer({ optInId: 'small', value: 5 });
    const large = offer({ optInId: 'large', kind: 'FLAT', value: 80 });
    expect(bestCampaign([small, large], 100_000)?.offer.optInId).toBe('large');
    expect(bestCampaign([large, small], 100_000)?.offer.optInId).toBe('large');

    const earlier = offer({ optInId: 'earlier', optedInAt: new Date('2026-09-01T00:00:00Z') });
    const later = offer({ optInId: 'later', optedInAt: new Date('2026-10-05T00:00:00Z') });
    expect(bestCampaign([later, earlier], 100_000)?.offer.optInId).toBe('earlier');
    expect(bestCampaign([], 100_000)).toBeNull();
    expect(bestCampaign([offer({ minCartNpr: 5000 })], 100_000)).toBeNull();
  });

  it('splits the discount so the two shares always add up to it', () => {
    // 33.33 at 33.33% vendor share: 11.108889 rounds to 11.11; the platform bears 22.22.
    const applied = bestCampaign(
      [offer({ kind: 'FLAT', value: 33.33, vendorSharePercent: 33.33 })],
      100_000,
    );
    expect(applied).toMatchObject({ discountPaisa: 3333, vendorSharePaisa: 1111 });
    for (const share of [0, 100, 50, 12.5, 99.99]) {
      const one = bestCampaign(
        [offer({ kind: 'FLAT', value: 0.01, vendorSharePercent: share })],
        500,
      );
      expect(one?.vendorSharePaisa).toBeGreaterThanOrEqual(0);
      expect(one?.vendorSharePaisa).toBeLessThanOrEqual(one?.discountPaisa ?? 0);
    }
  });

  it('prices SPEC verification 5 without a vendor offer: total 950, commission on 950', () => {
    const cart = new Map<string, PricingProduct>([['x', { id: 'x', name: 'X', price_npr: 500 }]]);
    const priced = priceCart(vendor, cart, [{ productId: 'x', quantity: 2 }], undefined, [offer()]);

    expect(priced).toMatchObject({
      subtotalPaisa: 100_000,
      deliveryFeePaisa: 5000,
      // 10% of (1000 - the vendor's 50): never on the platform's subsidy.
      commissionPaisa: 9500,
      totalPaisa: 95_000,
      promo: { discountPaisa: 10_000, vendorSharePaisa: 5000 },
    });
  });

  it('judges the minimum order on the subtotal before the discount, and never discounts delivery', () => {
    const cart = new Map<string, PricingProduct>([['x', { id: 'x', name: 'X', price_npr: 500 }]]);
    // The whole subtotal off: the customer still pays the delivery fee, and the cart is not "below minimum".
    const priced = priceCart(vendor, cart, [{ productId: 'x', quantity: 1 }], undefined, [
      offer({ kind: 'FLAT', value: 500, vendorSharePercent: 100 }),
    ]);
    expect(priced).toMatchObject({ totalPaisa: 5000, commissionPaisa: 0 });
    expect(priceCart(vendor, cart, [{ productId: 'x', quantity: 1 }]).promo).toBeNull();
  });
});

describe('stacking a vendor offer and a platform campaign (SPEC core 7 and 9)', () => {
  const vendorOffer = (overrides: Partial<VendorOfferRule> = {}): VendorOfferRule => ({
    offerId: 'offer',
    createdAt: new Date('2026-10-01T00:00:00Z'),
    label: 'Flat Rs. 100 OFF',
    kind: 'FLAT',
    value: 100,
    maxDiscountNpr: null,
    minCartNpr: 100,
    ...overrides,
  });
  const campaign = (overrides: Partial<CampaignOffer> = {}): CampaignOffer => ({
    campaignId: 'campaign',
    optInId: 'opt-in',
    optedInAt: new Date('2026-10-01T00:00:00Z'),
    name: 'Dashain 10%',
    kind: 'PERCENTAGE',
    value: 10,
    maxDiscountNpr: null,
    minCartNpr: 0,
    vendorSharePercent: 50,
    termsVersion: 1,
    ...overrides,
  });
  const cart = new Map<string, PricingProduct>([['x', { id: 'x', name: 'X', price_npr: 500 }]]);
  const price = (
    offers: readonly VendorOfferRule[],
    campaigns: readonly CampaignOffer[],
    seller: PricingVendor = vendor,
    quantity = 2,
  ) => priceCart(seller, cart, [{ productId: 'x', quantity }], undefined, campaigns, offers);

  it('prices SPEC verification 5: total 860, commission 85.50 on a base of 855', () => {
    const priced = price([vendorOffer()], [campaign()]);

    expect(priced).toMatchObject({
      subtotalPaisa: 100_000,
      vendorOffer: { discountPaisa: 10_000 },
      // 10% of the 900 left after the vendor offer; the vendor bears half.
      promo: { discountPaisa: 9000, vendorSharePaisa: 4500 },
      deliveryFeePaisa: 5000,
      totalPaisa: 86_000,
      // 10% of S - Dv - Dpv = 1000 - 100 - 45.
      commissionPaisa: 8550,
    });
  });

  it('charges commission on S - Dv - Dpv for every split of the campaign', () => {
    for (const share of [0, 25, 33.33, 50, 100]) {
      for (const rate of [0.05, 0.1, 0.0725]) {
        const priced = price(
          [vendorOffer({ kind: 'PERCENTAGE', value: 12.5, minCartNpr: 0 })],
          [campaign({ value: 7.5, vendorSharePercent: share })],
          { ...vendor, commission_rate: rate },
          3,
        );
        const dv = priced.vendorOffer?.discountPaisa ?? 0;
        const dp = priced.promo?.discountPaisa ?? 0;
        const dpv = priced.promo?.vendorSharePaisa ?? 0;
        const base = priced.subtotalPaisa - dv - dpv;

        expect(dv).toBe(18_750); // 12.5% of 1500
        expect(dp).toBe(Math.round((priced.subtotalPaisa - dv) * 0.075));
        expect(priced.commissionPaisa).toBe(
          Math.round((base * Math.round(rate * 10_000)) / 10_000),
        );
        expect(priced.totalPaisa).toBe(priced.subtotalPaisa - dv - dp + priced.deliveryFeePaisa);
      }
    }
  });

  it('applies the vendor offer first: the campaign sees what is left, for its minimum cart too', () => {
    // 1000 reaches a campaign from 950; after 100 off, 900 does not.
    expect(price([], [campaign({ minCartNpr: 950 })]).promo?.discountPaisa).toBe(10_000);
    const stacked = price([vendorOffer()], [campaign({ minCartNpr: 950 })]);
    expect(stacked.promo).toBeNull();
    expect(stacked.totalPaisa).toBe(95_000);
    // The vendor offer's own minimum is judged on the whole subtotal.
    expect(price([vendorOffer({ minCartNpr: 1000.01 })], []).vendorOffer).toBeNull();
  });

  it('takes a vendor offer alone: commission on S - Dv, no promo', () => {
    expect(price([vendorOffer()], [])).toMatchObject({
      promo: null,
      totalPaisa: 95_000,
      commissionPaisa: 9000,
    });
  });

  it('picks the larger vendor offer; between equal ones, the older', () => {
    const older = vendorOffer({ offerId: 'a', createdAt: new Date('2026-09-01T00:00:00Z') });
    const same = vendorOffer({ offerId: 'b', kind: 'PERCENTAGE', value: 10, minCartNpr: 0 });
    const larger = vendorOffer({ offerId: 'c', kind: 'PERCENTAGE', value: 15, minCartNpr: 0 });

    expect(bestVendorOffer([same, older], 100_000)?.offer.offerId).toBe('a');
    expect(bestVendorOffer([older, same, larger], 100_000)).toMatchObject({
      offer: { offerId: 'c' },
      discountPaisa: 15_000,
    });
    expect(bestVendorOffer([], 100_000)).toBeNull();
  });

  it('caps a percentage offer, and never discounts more than the goods or the delivery fee', () => {
    expect(
      price(
        [vendorOffer({ kind: 'PERCENTAGE', value: 20, maxDiscountNpr: 150, minCartNpr: 0 })],
        [],
      ).vendorOffer?.discountPaisa,
    ).toBe(15_000);
    // Everything off the goods: the campaign has nothing left, and delivery is still charged.
    const free = price(
      [vendorOffer({ kind: 'PERCENTAGE', value: 100, minCartNpr: 0 })],
      [campaign({ kind: 'FLAT', value: 50 })],
    );
    expect(free).toMatchObject({ promo: null, totalPaisa: 5000, commissionPaisa: 0 });
  });

  it('charges a subscription vendor no commission on a stacked cart', () => {
    const priced = price([vendorOffer()], [campaign()], {
      ...vendor,
      pricing_model: 'SUBSCRIPTION',
      commission_rate: 0,
    });
    expect(priced).toMatchObject({ commissionPaisa: 0, totalPaisa: 86_000 });
  });
});

describe('discounts before the delivery threshold (SPEC core 9, amended 2026-10-21)', () => {
  const cart = new Map<string, PricingProduct>([['x', { id: 'x', name: 'X', price_npr: 500 }]]);
  const offer: VendorOfferRule = {
    offerId: 'offer',
    createdAt: new Date('2026-10-01T00:00:00Z'),
    label: 'Flat Rs. 100 OFF',
    kind: 'FLAT',
    value: 100,
    maxDiscountNpr: null,
    minCartNpr: 0,
  };
  const terms: DeliveryTerms = {
    fulfillmentMode: 'PLATFORM_FLEET',
    deliveryScope: 'RADIUS_BOUND',
    baseFeeNpr: 0,
    perKmFeeNpr: 0,
    freeAboveNpr: null,
    platformFeeNpr: 50,
    platformFreeAboveNpr: 1000,
  };
  const price = (quantity: number, offers: readonly VendorOfferRule[]) =>
    priceCart(
      vendor,
      cart,
      [{ productId: 'x', quantity }],
      (goodsPaisa) => deliveryCharge(terms, goodsPaisa, 2),
      [],
      offers,
    );

  it('judges the threshold on the goods after the discount, not on the subtotal', () => {
    // Subtotal 1000 reaches the threshold, but after Rs. 100 off the goods are 900: fee charged.
    expect(price(2, [offer])).toMatchObject({
      subtotalPaisa: 100_000,
      goodsPaisa: 90_000,
      deliveryFeePaisa: 5_000,
      deliverySubsidyPaisa: 0,
      freeDeliveryBy: null,
      totalPaisa: 95_000,
    });
  });

  it('ships free the moment the discounted goods reach it, the platform paying the fee', () => {
    expect(price(3, [offer])).toMatchObject({
      subtotalPaisa: 150_000,
      goodsPaisa: 140_000,
      deliveryFeePaisa: 0,
      deliverySubsidyPaisa: 5_000,
      freeDeliveryBy: 'PLATFORM',
      totalPaisa: 140_000,
    });
    expect(price(2, [])).toMatchObject({ goodsPaisa: 100_000, deliveryFeePaisa: 0 });
  });

  it('keeps the minimum order on the subtotal before the discount', () => {
    expect(() =>
      priceCart(
        { ...vendor, min_order_value: 1000 },
        cart,
        [{ productId: 'x', quantity: 2 }],
        undefined,
        [],
        [offer],
      ),
    ).not.toThrow();
  });
});

describe('decimal cart math', () => {
  it('takes 12.5% of Rs. 9.99 as 125 paisa (half-up), not 124', () => {
    const tiny = new Map<string, PricingProduct>([['t', { id: 't', name: 'T', price_npr: 9.99 }]]);
    const priced = priceCart(
      { ...vendor, min_order_value: 0 },
      tiny,
      [{ productId: 't', quantity: 1 }],
      undefined,
      [],
      [
        {
          offerId: 'o',
          createdAt: new Date('2026-10-01T00:00:00Z'),
          label: '12.5% OFF',
          kind: 'PERCENTAGE',
          value: 12.5,
          maxDiscountNpr: null,
          minCartNpr: 0,
        },
      ],
    );
    expect(priced.vendorOffer?.discountPaisa).toBe(125);
  });
});
