import {
  bestCampaign,
  campaignDiscountPaisa,
  CheckoutRejectedError,
  priceCart,
  type CampaignOffer,
  type PricingProduct,
  type PricingVendor,
} from './pricing';

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
