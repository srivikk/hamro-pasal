import { CSV_BOM, csvCell, csvRow } from './csv';
import { bsDate, nepalDateTime, nepalDayRange } from './time';
import { exportFileName } from './write';

describe('CSV cells (step 7.6, SPEC verification 30)', () => {
  it.each([
    [
      '=HYPERLINK("http://evil.example","click")',
      `"'=HYPERLINK(""http://evil.example"",""click"")"`,
    ],
    ['+977 98', "'+977 98"],
    ['-2+3', "'-2+3"],
    ['@SUM(A1:A9)', "'@SUM(A1:A9)"],
    ['\tTabbed', "'\tTabbed"],
    ['\rReturn', `"'\rReturn"`],
  ])('escapes a text cell that a spreadsheet would run as a formula: %j', (value, expected) => {
    expect(csvCell(value)).toBe(expected);
  });

  it('writes amounts as plain numbers, negative ones included', () => {
    expect(csvCell(-100)).toBe('-100');
    expect(csvCell(1234.5)).toBe('1234.5');
    expect(csvCell(Number.NaN)).toBe('');
  });

  it('quotes commas, quotes and line breaks, and leaves plain text alone', () => {
    expect(csvCell('Thamel, Kathmandu')).toBe('"Thamel, Kathmandu"');
    expect(csvCell('5" pot')).toBe('"5"" pot"');
    expect(csvCell('two\nlines')).toBe('"two\nlines"');
    expect(csvCell('थमेल किराना')).toBe('थमेल किराना');
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
    expect(csvCell(true)).toBe('true');
  });

  it('ends each row with CRLF, and starts the file with the UTF-8 BOM for Excel', () => {
    expect(csvRow(['a', 1, null, '=1+1'])).toBe("a,1,,'=1+1\r\n");
    expect(CSV_BOM).toBe('﻿');
  });
});

describe('Nepal Time in exports', () => {
  it('shows moments in Nepal Time (UTC+05:45)', () => {
    expect(nepalDateTime(new Date('2026-10-16T18:20:00.000Z'))).toBe('2026-10-17 00:05');
    expect(nepalDateTime(null)).toBeNull();
  });

  it('gives the Bikram Sambat date beside it', () => {
    expect(bsDate(new Date('2026-10-16T06:00:00.000Z'))).toMatch(/^2083-0[67]-\d{2}$/);
  });

  it('covers whole Nepal-Time days, the last one included', () => {
    const { start, end } = nepalDayRange('2026-10-01', '2026-10-01');
    expect(start.toISOString()).toBe('2026-09-30T18:15:00.000Z');
    expect(end.toISOString()).toBe('2026-10-01T18:15:00.000Z');
  });

  it('names files after the kind and the range', () => {
    expect(exportFileName('AUDIT_LOG', { from: '2026-10-01', to: '2026-10-16' }, 'zip')).toBe(
      'hamro-pasal-audit-log-2026-10-01-to-2026-10-16.zip',
    );
  });
});
