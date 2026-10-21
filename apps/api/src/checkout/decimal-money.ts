import Decimal from 'decimal.js';

/*
 * Cart arithmetic in decimal (decided 2026-10-21, SPEC core 9 "Zero-error cart math").
 *
 * Amounts travel between the steps of a cart as integer paisa: adding and subtracting whole
 * numbers below 2^53 is exact. Every step that multiplies, divides or rounds goes through
 * decimal.js instead of binary floating point, with one rounding rule, half-up to the paisa. A
 * value read as a JavaScript number (a NUMERIC column, a percentage, a rate) enters by its shortest
 * decimal spelling (`String(0.1)` is "0.1"), so 1.005 NPR is 100.5 paisa, never 100.49999.
 */
const Money = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });
type MoneyDecimal = InstanceType<typeof Money>;

/** A decimal from a number or a NUMERIC string, refusing NaN and infinities. */
function decimalOf(value: number | string): MoneyDecimal {
  const decimal = new Money(typeof value === 'number' ? String(value) : value.trim());
  if (!decimal.isFinite()) throw new RangeError(`${String(value)} is not a finite amount`);
  return decimal;
}

/** A whole number of paisa as a safe JavaScript integer. */
function toSafePaisa(paisa: MoneyDecimal, from: number | string): number {
  const value = paisa.toNumber();
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`${String(from)} is outside the range of exact paisa amounts`);
  }
  return value;
}

/** Rounds a decimal number of paisa half-up to a whole paisa. */
function roundToPaisa(paisa: MoneyDecimal, from: number | string): number {
  return toSafePaisa(paisa.toDecimalPlaces(0, Money.ROUND_HALF_UP), from);
}

/**
 * An NPR amount (a price, a fee, a threshold) as whole paisa. Refuses an amount with a fraction
 * of a paisa: money is stored as NUMERIC(12,2), so such a value is a bug, not something to round.
 */
export function paisaOf(npr: number | string): number {
  const paisa = decimalOf(npr).times(100);
  if (!paisa.isInteger()) throw new RangeError(`${String(npr)} NPR is not a whole number of paisa`);
  return toSafePaisa(paisa, npr);
}

/** `percent`% of an amount in paisa, half-up to the paisa: 12.5% of 999 paisa is 125 paisa. */
export function percentOfPaisa(amountPaisa: number, percent: number | string): number {
  return roundToPaisa(new Money(amountPaisa).times(decimalOf(percent)).dividedBy(100), percent);
}

/** A rate (0.1 for 10%) of an amount in paisa, half-up to the paisa. */
export function rateOfPaisa(amountPaisa: number, rate: number | string): number {
  return roundToPaisa(new Money(amountPaisa).times(decimalOf(rate)), rate);
}

/** `count` times a per-unit amount in NPR, as paisa (a per-km fee times whole kilometres). */
export function timesPaisa(npr: number | string, count: number): number {
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new RangeError(`${String(count)} is not a whole, non-negative count`);
  }
  return toSafePaisa(new Money(paisaOf(npr)).times(count), npr);
}
