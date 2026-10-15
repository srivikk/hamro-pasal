import {
  recordAuditLog,
  vendorOpeningHours,
  vendors,
  type Database,
  type Transaction,
} from '@hamro-pasal/db';
import {
  weekSpan,
  type AuditActor,
  type AuditContext,
  type AvailabilityRequest,
  type AvailabilityResponseBody,
  type OpeningRange,
} from '@hamro-pasal/shared-types';
import { asc, eq } from 'drizzle-orm';

import { closedReason } from '../catalog/catalog-service';
import { VendorAccountNotFoundError } from '../orders/vendor-order-service';

type VendorRow = typeof vendors.$inferSelect;

const WEEK_MINUTES = 7 * 1440;
const NEPAL_OFFSET_MS = (5 * 60 + 45) * 60_000;

/** "HH:MM:SS" (PostgreSQL `time`) as "HH:MM". */
const hhmm = (time: string): string => time.slice(0, 5);

/**
 * The next opening or closing time of the week after `now`, or null without hours. An override
 * lasts until then (SPEC core 11): "Closed now" at 20:00 opens again at the next opening time.
 */
export function nextBoundary(ranges: readonly OpeningRange[], now: Date): Date | null {
  if (ranges.length === 0) return null;
  const local = new Date(now.getTime() + NEPAL_OFFSET_MS);
  const nowMinute = local.getUTCDay() * 1440 + local.getUTCHours() * 60 + local.getUTCMinutes();
  const startOfMinute = now.getTime() - local.getUTCSeconds() * 1000 - local.getUTCMilliseconds();
  let soonest = Number.POSITIVE_INFINITY;
  for (const range of ranges) {
    for (const boundary of weekSpan(range)) {
      const ahead = (boundary - nowMinute + WEEK_MINUTES * 2) % WEEK_MINUTES;
      soonest = Math.min(soonest, ahead === 0 ? WEEK_MINUTES : ahead);
    }
  }
  return new Date(startOfMinute + soonest * 60_000);
}

/** Step 7.3 (SPEC core 11): a shop's weekly opening hours and its Open / Closed switch. */
export class VendorAvailabilityService {
  constructor(private readonly db: Database) {}

  async hours(vendorUserId: string): Promise<{ vendorId: string; ranges: OpeningRange[] }> {
    const vendor = await this.vendorOf(this.db, vendorUserId);
    return { vendorId: vendor.id, ranges: await rangesOf(this.db, vendor.id) };
  }

  /** Replaces the whole week under the vendor row lock, with its audit entry. */
  async setHours(
    actor: AuditActor & { kind: 'USER' },
    ranges: readonly OpeningRange[],
    context: AuditContext,
  ): Promise<{ vendorId: string; ranges: OpeningRange[] }> {
    return this.db.transaction(async (tx) => {
      const vendor = await this.vendorOf(tx, actor.user_id, true);
      const before = await rangesOf(tx, vendor.id);
      await tx.delete(vendorOpeningHours).where(eq(vendorOpeningHours.vendor_id, vendor.id));
      if (ranges.length > 0) {
        await tx
          .insert(vendorOpeningHours)
          .values(ranges.map((range) => ({ vendor_id: vendor.id, ...range })));
      }
      const after = await rangesOf(tx, vendor.id);
      if (JSON.stringify(before) !== JSON.stringify(after)) {
        await recordAuditLog(tx, {
          actor,
          action: 'OPENING_HOURS_CHANGED',
          entityId: vendor.id,
          vendorId: vendor.id,
          beforeState: { ranges: before },
          afterState: { ranges: after },
          context,
        });
      }
      return { vendorId: vendor.id, ranges: after };
    });
  }

  async availability(vendorUserId: string): Promise<AvailabilityResponseBody> {
    const vendor = await this.vendorOf(this.db, vendorUserId);
    return this.view(this.db, vendor);
  }

  /**
   * AUTO follows the hours; OPEN / CLOSED last until the next boundary (indefinitely without
   * hours). OPEN and AUTO resume an auto-paused shop and clear its run of missed orders.
   */
  async setAvailability(
    actor: AuditActor & { kind: 'USER' },
    request: AvailabilityRequest,
    context: AuditContext,
  ): Promise<AvailabilityResponseBody> {
    return this.db.transaction(async (tx) => {
      const before = await this.vendorOf(tx, actor.user_id, true);
      const until =
        request.mode === 'AUTO' ? null : nextBoundary(await rangesOf(tx, before.id), new Date());
      const resume = request.mode !== 'CLOSED';
      const [after] = await tx
        .update(vendors)
        .set({
          availability_override: request.mode === 'AUTO' ? 'NONE' : request.mode,
          availability_override_until: until,
          ...(resume ? { auto_paused_at: null, consecutive_missed_orders: 0 } : {}),
        })
        .where(eq(vendors.id, before.id))
        .returning();
      if (after === undefined) throw new Error(`Vendor ${before.id} vanished`);
      await recordAuditLog(tx, {
        actor,
        action: 'AVAILABILITY_CHANGED',
        entityId: before.id,
        vendorId: before.id,
        beforeState: stateOf(before),
        afterState: stateOf(after),
        context,
      });
      return this.view(tx, after);
    });
  }

  private async view(
    executor: Database | Transaction,
    vendor: VendorRow,
  ): Promise<AvailabilityResponseBody> {
    const [row] = await executor
      .select({ reason: closedReason() })
      .from(vendors)
      .where(eq(vendors.id, vendor.id));
    const running =
      vendor.availability_override !== 'NONE' &&
      (vendor.availability_override_until === null ||
        vendor.availability_override_until > new Date());
    const reason = row?.reason ?? null;
    return {
      vendor_id: vendor.id,
      mode:
        running && vendor.availability_override !== 'NONE' ? vendor.availability_override : 'AUTO',
      override_until: running ? (vendor.availability_override_until?.toISOString() ?? null) : null,
      has_hours: (await rangesOf(executor, vendor.id)).length > 0,
      auto_paused_at: vendor.auto_paused_at?.toISOString() ?? null,
      consecutive_missed_orders: vendor.consecutive_missed_orders,
      open_now: reason === null,
      closed_reason: reason,
    };
  }

  private async vendorOf(
    executor: Database | Transaction,
    userId: string,
    lock = false,
  ): Promise<VendorRow> {
    const query = executor.select().from(vendors).where(eq(vendors.user_id, userId));
    const [vendor] = lock ? await query.for('update') : await query;
    if (vendor === undefined) throw new VendorAccountNotFoundError(userId);
    return vendor;
  }
}

function stateOf(vendor: VendorRow) {
  return {
    availability_override: vendor.availability_override,
    availability_override_until: vendor.availability_override_until?.toISOString() ?? null,
    auto_paused_at: vendor.auto_paused_at?.toISOString() ?? null,
  };
}

async function rangesOf(
  executor: Database | Transaction,
  vendorId: string,
): Promise<OpeningRange[]> {
  const rows = await executor
    .select()
    .from(vendorOpeningHours)
    .where(eq(vendorOpeningHours.vendor_id, vendorId))
    .orderBy(asc(vendorOpeningHours.weekday), asc(vendorOpeningHours.opens_at));
  return rows.map((row) => ({
    weekday: row.weekday,
    opens_at: hhmm(row.opens_at),
    closes_at: hhmm(row.closes_at),
  }));
}
