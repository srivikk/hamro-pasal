const DEVANAGARI_DIGITS = ['०', '१', '२', '३', '४', '५', '६', '७', '८', '९'] as const;

/**
 * Renders a number with Devanagari digits (०-९), for prices, timestamps and quantities when the
 * locale is `ne` (SPEC implicit requirement 2). The sign and decimal point are kept, there is
 * no digit grouping, and the value is never shown in exponent notation.
 *
 * toNepaliNumerals(1250.5) === '१२५०.५'
 */
export function toNepaliNumerals(num: number): string {
  if (!Number.isFinite(num)) {
    throw new RangeError(`Cannot render ${String(num)} as Nepali numerals`);
  }
  const plain = (Object.is(num, -0) ? 0 : num).toLocaleString('en-US', {
    useGrouping: false,
    maximumFractionDigits: 20,
  });
  return plain.replace(/[0-9]/g, (digit) => DEVANAGARI_DIGITS[Number(digit)] ?? digit);
}
