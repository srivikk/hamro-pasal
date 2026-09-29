import { toNepaliNumerals } from '@hamro-pasal/shared-types';

import type { AppLocale } from './app-locale';

/**
 * Renders a price, quantity or timestamp component for the active locale: Devanagari digits
 * (०-९) under `ne`, ASCII digits under `en`. Both use the same shape (no grouping, no exponent),
 * so switching language changes only the glyphs.
 */
export function formatLocalizedNumber(value: number, locale: AppLocale): string {
  if (locale === 'ne') return toNepaliNumerals(value);
  if (!Number.isFinite(value)) {
    throw new RangeError(`Cannot render ${String(value)} as a localized number`);
  }
  return (Object.is(value, -0) ? 0 : value).toLocaleString('en-US', {
    useGrouping: false,
    maximumFractionDigits: 20,
  });
}
