import { computeCartSummary, CUSTOMER_PLATFORM_FEE_NPR } from './cart-summary';

const vendor = { id: 'v', name: 'Thamel Kirana Pasal', deliveryFeeNpr: 50, minOrderValueNpr: 500 };
const line = (productId: string, unitPriceNpr: number, quantity: number) => ({
  productId,
  name: productId,
  unitPriceNpr,
  quantity,
});

describe('computeCartSummary', () => {
  it('adds the delivery fee to the subtotal, with no platform fee for the customer (SPEC §4)', () => {
    const summary = computeCartSummary(vendor, [line('rice', 1150, 1), line('tea', 450, 2)]);

    expect(CUSTOMER_PLATFORM_FEE_NPR).toBe(0);
    expect(summary).toEqual({
      subtotalNpr: 2050,
      deliveryFeeNpr: 50,
      platformFeeNpr: 0,
      totalNpr: 2100,
      shortOfMinimumNpr: 0,
    });
  });

  it('matches the server total (subtotal + delivery fee) to the paisa', () => {
    const summary = computeCartSummary({ ...vendor, deliveryFeeNpr: 49.99 }, [
      line('a', 0.1, 3),
      line('b', 120.45, 2),
    ]);

    expect(summary.subtotalNpr).toBe(241.2);
    expect(summary.totalNpr).toBe(291.19);
  });

  it('reports how far the subtotal is below the MOV (SPEC step 5)', () => {
    expect(computeCartSummary(vendor, [line('tea', 450, 1)]).shortOfMinimumNpr).toBe(50);
    expect(computeCartSummary(vendor, [line('tea', 250, 2)]).shortOfMinimumNpr).toBe(0);
  });

  it('does not count the delivery fee towards the MOV', () => {
    expect(computeCartSummary(vendor, [line('tea', 460, 1)]).shortOfMinimumNpr).toBe(40);
  });
});
