import type { ShopClosedReason } from '@hamro-pasal/shared-types';
import { sql, type SQL } from 'drizzle-orm';

import { vendors } from './schema';

/** Asia/Kathmandu minute of the week now (0 = Sunday 00:00), on the database clock. */
const NOW_MINUTE_OF_WEEK = sql`(
  extract(dow FROM now() AT TIME ZONE 'Asia/Kathmandu')::int * 1440
  + extract(hour FROM now() AT TIME ZONE 'Asia/Kathmandu')::int * 60
  + extract(minute FROM now() AT TIME ZONE 'Asia/Kathmandu')::int)`;

/**
 * Step 7.3 (SPEC core 11): why a vendor takes no order now, as one SQL expression over `vendors`
 * ('AUTO_PAUSED', 'OVERRIDE', 'HOURS'), or NULL when it is open. Derived on every read from the
 * clock: nothing is written at opening or closing time. In order:
 *   - an auto-paused shop is closed until its vendor resumes;
 *   - a running override (OPEN / CLOSED until its end, or indefinitely) wins over the hours;
 *   - a shop without hours is open;
 *   - otherwise it is open inside a range that still has at least
 *     platform_settings.last_order_minutes_before_close minutes to run (checkout stops then).
 * A range is [start, start + length) minutes of the circular week; one past midnight wraps.
 */
export function vendorClosedReason(): SQL<ShopClosedReason | null> {
  // Qualified by hand: in a single-table select Drizzle prints ${vendors.id} as a bare "id",
  // which inside these subqueries would bind to vendor_opening_hours.id (STATE_HANDOFF §8Z.33).
  const vendorId = sql.raw('"vendors"."id"');
  const running = sql`(${vendors.availability_override_until} IS NULL OR ${vendors.availability_override_until} > now())`;
  return sql<ShopClosedReason | null>`(CASE
    WHEN ${vendors.auto_paused_at} IS NOT NULL THEN 'AUTO_PAUSED'
    WHEN ${vendors.availability_override} = 'OPEN' AND ${running} THEN NULL
    WHEN ${vendors.availability_override} = 'CLOSED' AND ${running} THEN 'OVERRIDE'
    WHEN NOT EXISTS (SELECT 1 FROM vendor_opening_hours h WHERE h.vendor_id = ${vendorId}) THEN NULL
    WHEN EXISTS (
      SELECT 1 FROM vendor_opening_hours h,
        LATERAL (SELECT
          h.weekday * 1440 + (extract(epoch FROM h.opens_at) / 60)::int AS start,
          (((extract(epoch FROM h.closes_at) - extract(epoch FROM h.opens_at)) / 60)::int + 1440) % 1440 AS length
        ) r
      WHERE h.vendor_id = ${vendorId}
        AND (${NOW_MINUTE_OF_WEEK} - r.start + 10080) % 10080
            < r.length - (SELECT last_order_minutes_before_close FROM platform_settings)
    ) THEN NULL
    ELSE 'HOURS'
  END)`;
}
