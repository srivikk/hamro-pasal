/*
 * Step 7.6 (SPEC core 11, verification 30): CSV for spreadsheets, safe to open.
 *
 * CSV injection: a spreadsheet treats a cell starting with `=`, `+`, `-` or `@` (and, in some,
 * a tab or a carriage return) as a formula. Any such text cell is prefixed with `'`, which the
 * spreadsheet shows as plain text. Numbers are written as plain numbers (so a negative amount
 * stays a number); only text is escaped.
 */

/** UTF-8 byte order mark: Excel then reads Nepali text (Devanagari) correctly. */
export const CSV_BOM = '﻿';

/** Cells a spreadsheet would read as a formula, by their first character. */
const FORMULA_START = /^[=+\-@\t\r]/;

export type CsvValue = string | number | boolean | null | undefined;

/** One cell, escaped against formulas and quoted when it holds a comma, quote or line break. */
export function csvCell(value: CsvValue): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return '';
    return String(value);
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  const text = FORMULA_START.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** One line, ended with CRLF (RFC 4180, and what Excel writes). */
export function csvRow(values: readonly CsvValue[]): string {
  return `${values.map(csvCell).join(',')}\r\n`;
}
