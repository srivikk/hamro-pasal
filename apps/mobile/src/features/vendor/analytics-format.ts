import type { VendorAnalyticsSummary } from '@hamro-pasal/shared-types';

/*
 * Display rules of the Analytics screen. The figures themselves are the server's
 * (GET /api/vendor/analytics/summary): nothing here computes a sale.
 */

/** Revenue per rupee spent on ads, to one decimal ("4.5"); null when nothing was spent. */
export function adRoiRatio(roi: VendorAnalyticsSummary['ad_roi']): number | null {
  if (roi === null || roi.spend_npr <= 0) return null;
  return Math.round((roi.revenue_npr / roi.spend_npr) * 10) / 10;
}

/**
 * The chart's bar heights, as whole class names so Tailwind finds them: a day's bar is the tallest
 * step its share of the best day reaches, and a day with sales never drops to nothing.
 */
export const BAR_HEIGHT_CLASSES = [
  'h-1',
  'h-4',
  'h-8',
  'h-12',
  'h-16',
  'h-20',
  'h-24',
  'h-28',
] as const;

/** Which step of `BAR_HEIGHT_CLASSES` a value gets: 0 for no sales, the top step for the best day. */
export function barStep(value: number, max: number): number {
  if (value <= 0 || max <= 0) return 0;
  const top = BAR_HEIGHT_CLASSES.length - 1;
  return Math.max(1, Math.min(top, Math.round((value / max) * top)));
}
