import { z } from 'zod';

import { MAX_OPENING_RANGES_PER_DAY } from '../domain/constants';
import { shopClosedReasonSchema } from '../domain/enums';

/*
 * Step 7.3 (SPEC core 11): a shop's weekly opening hours and its Open / Closed switch.
 * Times are Asia/Kathmandu wall-clock "HH:MM"; a range whose closing time is earlier than its
 * opening time runs past midnight and belongs to the weekday it starts on.
 */

const clockTime = z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/, 'Use HH:MM (24-hour)');

/** Minutes after midnight of an "HH:MM" time. */
export function minutesOf(time: string): number {
  const [hours = 0, minutes = 0] = time.split(':').map(Number);
  return hours * 60 + minutes;
}

export const openingRangeSchema = z
  .strictObject({
    /** 0 = Sunday ... 6 = Saturday. */
    weekday: z.number().int().min(0).max(6),
    opens_at: clockTime,
    closes_at: clockTime,
  })
  .refine((range) => range.opens_at !== range.closes_at, {
    path: ['closes_at'],
    message: 'A range must not open and close at the same time',
  });
export type OpeningRange = z.infer<typeof openingRangeSchema>;

/** The [start, end) minutes of the week a range covers; end may pass 10080 (Saturday night). */
export function weekSpan(range: OpeningRange): [number, number] {
  const start = range.weekday * 1440 + minutesOf(range.opens_at);
  const length = (minutesOf(range.closes_at) - minutesOf(range.opens_at) + 1440) % 1440;
  return [start, start + length];
}

/** PUT /api/vendor/opening-hours: replaces the whole week. An empty week means "no hours". */
export const openingHoursRequestSchema = z
  .strictObject({ ranges: z.array(openingRangeSchema).max(7 * MAX_OPENING_RANGES_PER_DAY) })
  .refine(
    ({ ranges }) =>
      [0, 1, 2, 3, 4, 5, 6].every(
        (day) =>
          ranges.filter((range) => range.weekday === day).length <= MAX_OPENING_RANGES_PER_DAY,
      ),
    { path: ['ranges'], message: `At most ${String(MAX_OPENING_RANGES_PER_DAY)} ranges a day` },
  )
  .refine(
    ({ ranges }) => {
      const spans = ranges.map(weekSpan);
      return spans.every(([start, end], i) =>
        spans.every(([otherStart, otherEnd], j) => {
          if (i === j) return true;
          // Compare on the circular week: shift the other span by a week either way.
          return [-10080, 0, 10080].every(
            (shift) => end <= otherStart + shift || otherEnd + shift <= start,
          );
        }),
      );
    },
    { path: ['ranges'], message: 'Ranges must not overlap' },
  );
export type OpeningHoursRequest = z.infer<typeof openingHoursRequestSchema>;

export const openingHoursResponseSchema = z.strictObject({
  vendor_id: z.uuid(),
  ranges: z.array(openingRangeSchema),
});
export type OpeningHoursResponseBody = z.infer<typeof openingHoursResponseSchema>;

/**
 * PUT /api/vendor/availability. AUTO follows the hours (and is "on" for a shop without hours);
 * OPEN / CLOSED last until the next scheduled boundary, or indefinitely without hours. OPEN and
 * AUTO also resume an auto-paused shop.
 */
export const availabilityModes = ['AUTO', 'OPEN', 'CLOSED'] as const;
export const availabilityRequestSchema = z.strictObject({ mode: z.enum(availabilityModes) });
export type AvailabilityRequest = z.infer<typeof availabilityRequestSchema>;

export const availabilityResponseSchema = z.strictObject({
  vendor_id: z.uuid(),
  mode: z.enum(availabilityModes),
  /** When OPEN / CLOSED ends; null for AUTO or an indefinite switch. */
  override_until: z.iso.datetime().nullable(),
  has_hours: z.boolean(),
  auto_paused_at: z.iso.datetime().nullable(),
  consecutive_missed_orders: z.number().int().min(0),
  open_now: z.boolean(),
  closed_reason: shopClosedReasonSchema.nullable(),
});
export type AvailabilityResponseBody = z.infer<typeof availabilityResponseSchema>;
