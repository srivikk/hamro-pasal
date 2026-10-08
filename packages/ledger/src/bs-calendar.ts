import NepaliDate from 'nepali-date-converter';

/** Nepal Time is UTC+05:45, with no daylight saving. */
const NPT_OFFSET_MS = (5 * 60 + 45) * 60 * 1000;

/** A Bikram Sambat calendar date. `month` is 1 (Baisakh) to 12 (Chaitra). */
export interface BsDate {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

/**
 * The BS month lengths come from `nepali-date-converter` (they follow no formula). The library
 * works on a JS Date's local calendar fields, so every conversion here goes through a Date whose
 * local fields are set to the Nepal Time calendar date: the result does not depend on the
 * machine's time zone.
 */
function nepalCalendarDate(instant: Date): Date {
  const npt = new Date(instant.getTime() + NPT_OFFSET_MS);
  return new Date(npt.getUTCFullYear(), npt.getUTCMonth(), npt.getUTCDate());
}

/** The BS date of an instant, in Nepal Time. */
export function bsDateOf(instant: Date): BsDate {
  const bs = new NepaliDate(nepalCalendarDate(instant));
  return { year: bs.getYear(), month: bs.getMonth() + 1, day: bs.getDate() };
}

/** 00:00 Nepal Time on the 1st of a BS month, as an instant. */
export function bsMonthStart(year: number, month: number): Date {
  const ad = new NepaliDate(year, month - 1, 1).toJsDate();
  return new Date(Date.UTC(ad.getFullYear(), ad.getMonth(), ad.getDate()) - NPT_OFFSET_MS);
}

/**
 * The first instant of the BS month after the one `instant` falls in: where a Billing Cycle ends
 * (SPEC core 4, exclusive). Always strictly after `instant`.
 */
export function nextBsMonthStart(instant: Date): Date {
  const { year, month } = bsDateOf(instant);
  return month === 12 ? bsMonthStart(year + 1, 1) : bsMonthStart(year, month + 1);
}

/** Shrawan, the BS month a Nepal fiscal year starts on. */
const FISCAL_YEAR_FIRST_MONTH = 4;

/**
 * The Nepal fiscal year an instant falls in, as the IRD writes it: "2082/083". It runs from
 * 1 Shrawan to the last day of Ashadh, in Nepal Time (SPEC Nepal section 5).
 */
export function fiscalYearOf(instant: Date): string {
  const { year, month } = bsDateOf(instant);
  const start = month >= FISCAL_YEAR_FIRST_MONTH ? year : year - 1;
  return `${String(start)}/${String((start + 1) % 1000).padStart(3, '0')}`;
}
