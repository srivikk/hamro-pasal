import { paisaOf, percentOfPaisa, rateOfPaisa, timesPaisa } from './decimal-money';

describe('decimal money', () => {
  it('reads an NPR amount as whole paisa by its decimal spelling, from a number or NUMERIC text', () => {
    expect(paisaOf(1150)).toBe(115_000);
    expect(paisaOf(450.55)).toBe(45_055);
    // Binary floating point: 1.005 * 100 is 100.49999999999999. Decimal: 100.5, refused below.
    expect(paisaOf(0.29)).toBe(29);
    expect(paisaOf('1234.56')).toBe(123_456);
    expect(paisaOf(' 10.10 ')).toBe(1_010);
  });

  it('refuses a fraction of a paisa, NaN and infinities rather than rounding them', () => {
    expect(() => paisaOf(1.005)).toThrow(RangeError);
    expect(() => paisaOf(Number.NaN)).toThrow(RangeError);
    expect(() => paisaOf(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });

  it('takes percentages and rates half-up to the paisa', () => {
    expect(percentOfPaisa(999, 12.5)).toBe(125); // 124.875
    expect(percentOfPaisa(1, 50)).toBe(1); // 0.5 rounds up
    expect(percentOfPaisa(1, 49.99)).toBe(0);
    expect(rateOfPaisa(115_000, 0.0725)).toBe(8_338); // 8337.5
    expect(rateOfPaisa(205_110, 0.1)).toBe(20_511);
    // Where float arithmetic drifts: 0.1 + 0.2 as a rate of 100 paisa is exactly 30.
    expect(rateOfPaisa(100, '0.3')).toBe(30);
  });

  it('multiplies a per-unit fee by whole units exactly', () => {
    expect(timesPaisa(0.1, 3)).toBe(30);
    expect(timesPaisa(10, 0)).toBe(0);
    expect(() => timesPaisa(10, 1.5)).toThrow(RangeError);
  });
});
