import { bsDateOf } from '@hamro-pasal/ledger';

/** Nepal Time is UTC+05:45, all year. */
const NPT_OFFSET_MS = (5 * 60 + 45) * 60_000;

const pad = (n: number, width = 2): string => String(n).padStart(width, '0');

/** `2026-10-16 14:05` in Nepal Time: how every export shows a moment. */
export function nepalDateTime(instant: Date | null): string | null {
  if (instant === null) return null;
  const npt = new Date(instant.getTime() + NPT_OFFSET_MS);
  return `${String(npt.getUTCFullYear())}-${pad(npt.getUTCMonth() + 1)}-${pad(npt.getUTCDate())} ${pad(
    npt.getUTCHours(),
  )}:${pad(npt.getUTCMinutes())}`;
}

/** `2083-06-30`: the Bikram Sambat date of a moment, in Nepal Time. */
export function bsDate(instant: Date | null): string | null {
  if (instant === null) return null;
  const bs = bsDateOf(instant);
  return `${String(bs.year)}-${pad(bs.month)}-${pad(bs.day)}`;
}

/**
 * The instants a range of Nepal-Time days covers: from 00:00 NPT on `from` to 00:00 NPT on the
 * day after `to` (exclusive).
 */
export function nepalDayRange(from: string, to: string): { start: Date; end: Date } {
  const start = new Date(`${from}T00:00:00+05:45`);
  const end = new Date(new Date(`${to}T00:00:00+05:45`).getTime() + 86_400_000);
  return { start, end };
}
