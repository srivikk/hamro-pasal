import { stockLevelsFromDetails } from './stock-shortfalls';

describe('stockLevelsFromDetails (409 INSUFFICIENT_STOCK details)', () => {
  it('reads every short line and what is left of it', () => {
    expect(
      stockLevelsFromDetails({
        shortfalls: [
          { productId: 'rice', requested: 5, available: 2 },
          { productId: 'tea', requested: 1, available: 0 },
        ],
      }),
    ).toEqual([
      { productId: 'rice', available: 2 },
      { productId: 'tea', available: 0 },
    ]);
  });

  it('never reports less than nothing, or a fraction', () => {
    expect(
      stockLevelsFromDetails({
        shortfalls: [
          { productId: 'rice', available: -3 },
          { productId: 'tea', available: 2.9 },
        ],
      }),
    ).toEqual([
      { productId: 'rice', available: 0 },
      { productId: 'tea', available: 2 },
    ]);
  });

  it.each([
    ['no details', undefined],
    ['null', null],
    ['no shortfalls', {}],
    ['shortfalls that are not a list', { shortfalls: 'rice' }],
    ['a line without a count', { shortfalls: [{ productId: 'rice' }] }],
    ['a line without a product', { shortfalls: [{ available: 1 }] }],
  ])('is empty for %s', (_label, details) => {
    expect(stockLevelsFromDetails(details)).toEqual([]);
  });
});
