import {
  CheckoutRejectedError,
  priceCart,
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
