import { vendors, type Database } from '@hamro-pasal/db';
import {
  ANALYTICS_AD_ROI_DAYS,
  ANALYTICS_DAILY_SALES_DAYS,
  ANALYTICS_TOP_ITEM_DAYS,
  ANALYTICS_WEEK_DAYS,
  type VendorAnalyticsSummary,
} from '@hamro-pasal/shared-types';
import { eq, sql, type SQL } from 'drizzle-orm';

import { VendorAccountNotFoundError } from '../orders/vendor-order-service';

/** Every day boundary is a calendar day here (UTC+05:45, no daylight saving). */
export const ANALYTICS_TIME_ZONE = 'Asia/Kathmandu';

/**
 * What an order earned the shop: the subtotal less the discounts the shop itself paid for (its
 * own offer and its share of a platform campaign). The platform's share of a campaign is not the
 * shop's cost, and the delivery fee is not its sale.
 */
const ORDER_SALES = sql`(o.subtotal - o.vendor_offer_discount_npr - o.platform_promo_vendor_share_npr)`;

/** 00:00 today in Nepal Time, as a timestamp without zone (a wall-clock value). */
const TODAY_LOCAL = sql`date_trunc('day', now() AT TIME ZONE ${ANALYTICS_TIME_ZONE})`;

/** The instant a Nepal Time day began, `daysAgo` days before today. */
function dayStart(daysAgo: number): SQL {
  return sql`((${TODAY_LOCAL} - make_interval(days => ${daysAgo})) AT TIME ZONE ${ANALYTICS_TIME_ZONE})`;
}

/**
 * The shop's analytics summary (GET /api/vendor/analytics/summary, STATE_HANDOFF.md §8Z.14).
 *
 * Read only. The four statements run in one REPEATABLE READ snapshot, so the day's total, the
 * chart's last bar and the top item describe the same set of orders. Every statement names the
 * caller's own vendor id: no parameter of the request chooses the shop.
 *
 * An order counts on the Nepal Time day it was DELIVERED (`delivered_at`), and only while its
 * state is DELIVERED: a cancelled or failed order never counts, and one that is later disputed
 * leaves the figures until the dispute is resolved.
 */
export class VendorAnalyticsService {
  constructor(private readonly db: Database) {}

  summary(vendorUserId: string): Promise<VendorAnalyticsSummary> {
    return this.db.transaction(
      async (tx) => {
        const [vendor] = await tx
          .select({ id: vendors.id })
          .from(vendors)
          .where(eq(vendors.user_id, vendorUserId));
        if (vendor === undefined) throw new VendorAccountNotFoundError(vendorUserId);
        const vendorId = vendor.id;

        // One row per day, today last, also for a day without a delivery (the LEFT JOIN).
        const days = await tx.execute<{ dow: number; sales: string; order_count: number }>(sql`
          SELECT extract(dow FROM d.day)::int AS dow,
                 coalesce(sum(${ORDER_SALES}), 0)::text AS sales,
                 count(o.id)::int AS order_count
          FROM generate_series(
                 ${TODAY_LOCAL} - make_interval(days => ${ANALYTICS_DAILY_SALES_DAYS - 1}),
                 ${TODAY_LOCAL},
                 interval '1 day'
               ) AS d(day)
          LEFT JOIN orders o
            ON o.vendor_id = ${vendorId}
           AND o.state = 'DELIVERED'
           AND o.delivered_at >= d.day AT TIME ZONE ${ANALYTICS_TIME_ZONE}
           AND o.delivered_at < (d.day + interval '1 day') AT TIME ZONE ${ANALYTICS_TIME_ZONE}
          GROUP BY d.day
          ORDER BY d.day`);

        // By volume. Ties: the larger amount, then the product id, so the answer is stable. The
        // name is the one on the most recent delivery (an order line keeps the name it was sold
        // under, and a product may have been renamed since).
        const top = await tx.execute<{ product_name: string; units: number; sales: string }>(sql`
          SELECT (array_agg(i.product_name ORDER BY o.delivered_at DESC, o.id DESC))[1]
                   AS product_name,
                 sum(i.quantity)::int AS units,
                 sum(i.quantity * i.unit_price_npr)::text AS sales
          FROM order_items i
          JOIN orders o ON o.id = i.order_id
          WHERE o.vendor_id = ${vendorId}
            AND o.state = 'DELIVERED'
            AND o.delivered_at >= ${dayStart(ANALYTICS_TOP_ITEM_DAYS - 1)}
          GROUP BY i.product_id
          ORDER BY units DESC, sum(i.quantity * i.unit_price_npr) DESC, i.product_id
          LIMIT 1`);

        const roiStart = dayStart(ANALYTICS_AD_ROI_DAYS - 1);
        // A purchase that was cancelled before it cost anything never ran as far as the shop's
        // money is concerned. Any other purchase counts for its whole booked period.
        const counted = sql`NOT (p.status = 'CANCELLED' AND p.amount_paid_npr = 0)`;
        const roi = await tx.execute<{ had_ad: boolean; spend: string; revenue: string }>(sql`
          SELECT
            EXISTS (
              SELECT 1 FROM ad_purchases p
              WHERE p.vendor_id = ${vendorId} AND ${counted}
                AND p.starts_at <= now() AND p.ends_at > ${roiStart}
            ) AS had_ad,
            -- What the ads cost: the fee postings into AD_REVENUE (a refund is the same line,
            -- negative, so it nets out). A held budget is not a cost until an order draws on it.
            (SELECT coalesce(sum(e.amount_npr), 0)
               FROM ledger_entries e
               JOIN ledger_accounts a ON a.id = e.account_id AND a.account_type = 'AD_REVENUE'
               JOIN ad_purchases p ON p.id = e.ad_purchase_id
              WHERE p.vendor_id = ${vendorId}
                AND e.line_type IN ('AD_FLAT_FEE', 'AD_ORDER_PREMIUM')
                AND e.created_at >= ${roiStart})::text AS spend,
            -- What they brought: sales of delivered orders placed while an ad of the shop ran.
            (SELECT coalesce(sum(${ORDER_SALES}), 0)
               FROM orders o
              WHERE o.vendor_id = ${vendorId}
                AND o.state = 'DELIVERED'
                AND o.delivered_at >= ${roiStart}
                AND EXISTS (
                  SELECT 1 FROM ad_purchases p
                  WHERE p.vendor_id = o.vendor_id AND ${counted}
                    AND o.placed_at >= p.starts_at AND o.placed_at < p.ends_at
                ))::text AS revenue`);

        const today = days.rows.at(-1);
        const best = top.rows[0];
        const ads = roi.rows[0];
        return {
          today_sales_npr: amount(today?.sales),
          today_order_count: today?.order_count ?? 0,
          top_item:
            best === undefined
              ? null
              : {
                  product_name: best.product_name,
                  units_sold: best.units,
                  sales_npr: amount(best.sales),
                },
          ad_roi:
            ads?.had_ad === true
              ? { spend_npr: amount(ads.spend), revenue_npr: amount(ads.revenue) }
              : null,
          daily_sales: days.rows.map((day) => ({
            day: ANALYTICS_WEEK_DAYS[day.dow] ?? 'SUN',
            sales_npr: amount(day.sales),
          })),
        };
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
  }
}

/** A numeric(12,2) sum as the API's number. Never negative: a contract of the summary. */
function amount(value: string | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}
