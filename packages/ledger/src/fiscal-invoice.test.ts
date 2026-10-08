import { fiscalYearOf } from './bs-calendar';
import { formatBsDate, invoiceSequenceOf } from './fiscal-invoice';

describe('the Nepal fiscal year', () => {
  it('runs from 1 Shrawan to the last day of Ashadh, written as the IRD writes it', () => {
    // 7 October 2025 = 21 Ashwin 2082.
    expect(fiscalYearOf(new Date('2025-10-07T06:00:00+05:45'))).toBe('2082/083');
    // Baisakh to Ashadh of BS 2082 still belong to the year that began in Shrawan 2081.
    expect(fiscalYearOf(new Date('2025-05-01T06:00:00+05:45'))).toBe('2081/082');
  });

  it('turns over at 00:00 Nepal Time on 1 Shrawan (17 July 2025), not at UTC midnight', () => {
    expect(fiscalYearOf(new Date('2025-07-16T18:14:59.999Z'))).toBe('2081/082');
    expect(fiscalYearOf(new Date('2025-07-16T18:15:00.000Z'))).toBe('2082/083');
  });

  it('writes the second year on three digits', () => {
    expect(fiscalYearOf(new Date('2026-08-01T06:00:00+05:45'))).toBe('2083/084');
  });
});

describe('the printed invoice number', () => {
  it('is HP, the fiscal year’s first year and the bill number on six digits', () => {
    expect(invoiceSequenceOf('2083/084', 142)).toBe('HP-2083-000142');
    expect(invoiceSequenceOf('2082/083', 1)).toBe('HP-2082-000001');
    // A seventh digit is kept, never cut.
    expect(invoiceSequenceOf('2082/083', 1_234_567)).toBe('HP-2082-1234567');
  });

  it('writes a BS date as YYYY-MM-DD', () => {
    expect(formatBsDate({ year: 2082, month: 6, day: 21 })).toBe('2082-06-21');
    expect(formatBsDate({ year: 2082, month: 12, day: 3 })).toBe('2082-12-03');
  });
});
