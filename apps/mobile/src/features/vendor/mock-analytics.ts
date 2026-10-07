/**
 * TEMPORARY: sample figures for the Analytics screen. No analytics endpoint exists yet
 * (`GET /api/vendor/analytics/summary`, STATE_HANDOFF.md §8Z.14). Development builds only; the
 * answer is delayed a little so the screen's loading state can be seen.
 */
export const VENDOR_ANALYTICS_MOCKS_ENABLED = __DEV__;
export const ANALYTICS_MOCK_DELAY_MS = 600;

export const WEEK_DAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'] as const;
export type WeekDay = (typeof WEEK_DAYS)[number];

/** The summary as the API will send it. */
export interface VendorAnalytics {
  today_sales_npr: number;
  today_order_count: number;
  top_item: { product_name: string; units_sold: number; sales_npr: number } | null;
  /** Delivered sales from orders placed while an ad ran, against what the ads cost. */
  ad_roi: { spend_npr: number; revenue_npr: number } | null;
  /** The last seven days, oldest first. */
  daily_sales: { day: WeekDay; sales_npr: number }[];
}

const SAMPLE: VendorAnalytics = {
  today_sales_npr: 12_450,
  today_order_count: 9,
  top_item: { product_name: 'Wai Wai Noodles (pack of 30)', units_sold: 14, sales_npr: 8400 },
  ad_roi: { spend_npr: 1200, revenue_npr: 5400 },
  daily_sales: [
    { day: 'THU', sales_npr: 6200 },
    { day: 'FRI', sales_npr: 9800 },
    { day: 'SAT', sales_npr: 15_300 },
    { day: 'SUN', sales_npr: 7400 },
    { day: 'MON', sales_npr: 0 },
    { day: 'TUE', sales_npr: 10_150 },
    { day: 'WED', sales_npr: 12_450 },
  ],
};

export function fetchMockAnalytics(): Promise<VendorAnalytics> {
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve(SAMPLE);
    }, ANALYTICS_MOCK_DELAY_MS);
  });
}

/** Revenue per rupee spent on ads, to one decimal ("4.5"); null when nothing was spent. */
export function adRoiRatio(roi: VendorAnalytics['ad_roi']): number | null {
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
