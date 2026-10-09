import { z } from 'zod';

/** Days of the week as the summary names them (the chart's labels), Sunday first. */
export const ANALYTICS_WEEK_DAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'] as const;
export const analyticsWeekDaySchema = z.enum(ANALYTICS_WEEK_DAYS);
export type AnalyticsWeekDay = z.infer<typeof analyticsWeekDaySchema>;

/** The chart covers today and the six days before it, in Nepal Time. */
export const ANALYTICS_DAILY_SALES_DAYS = 7;
/** The window the top item is counted over: the same days as the chart. */
export const ANALYTICS_TOP_ITEM_DAYS = 7;
/** The window of the ad return. */
export const ANALYTICS_AD_ROI_DAYS = 30;

const npr = z.number().min(0);

/**
 * GET /api/vendor/analytics/summary (STATE_HANDOFF.md §8Z.14): how the caller's shop is doing.
 *
 * "Sales" is always the delivered subtotal less the discounts the shop itself paid for (its own
 * offer and its share of a platform campaign): what its commission is charged on. A day is a
 * calendar day in Asia/Kathmandu, by the time the order was delivered.
 */
export const vendorAnalyticsSummarySchema = z.strictObject({
  today_sales_npr: npr,
  today_order_count: z.number().int().min(0),
  /** The product with the most units delivered in the last seven days; null without a delivery. */
  top_item: z
    .strictObject({
      product_name: z.string().min(1),
      units_sold: z.number().int().positive(),
      /** Units x the price each was sold at, before any discount on the order. */
      sales_npr: npr,
    })
    .nullable(),
  /**
   * The last 30 days: what the shop's ads cost it, against its sales from orders placed while one
   * of them ran. Null when no ad of the shop ran in that time.
   */
  ad_roi: z.strictObject({ spend_npr: npr, revenue_npr: npr }).nullable(),
  /** Seven entries, oldest first, today last. A day without a delivery is 0. */
  daily_sales: z
    .array(z.strictObject({ day: analyticsWeekDaySchema, sales_npr: npr }))
    .length(ANALYTICS_DAILY_SALES_DAYS),
});
export type VendorAnalyticsSummary = z.infer<typeof vendorAnalyticsSummarySchema>;
