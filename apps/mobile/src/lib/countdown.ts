import { useEffect, useState } from 'react';

import type { AppLocale } from '../i18n/app-locale';
import { formatLocalizedNumber } from '../i18n/format-number';

/** Milliseconds until `expiresAt` (ISO), floored at 0. Null or unparsable timestamps count as 0. */
export function remainingMs(expiresAt: string | null, nowMs: number): number {
  if (expiresAt === null) return 0;
  const end = Date.parse(expiresAt);
  return Number.isNaN(end) ? 0 : Math.max(0, end - nowMs);
}

/** `mm:ss`, rounded up so the display never shows 00:00 while time remains; Devanagari under `ne`. */
export function formatCountdown(ms: number, locale: AppLocale): string {
  const totalSeconds = Math.ceil(Math.max(0, ms) / 1000);
  const minutes = String(Math.floor(totalSeconds / 60)).padStart(2, '0');
  const seconds = String(totalSeconds % 60).padStart(2, '0');
  return `${minutes}:${seconds}`.replace(/[0-9]/g, (digit) =>
    formatLocalizedNumber(Number(digit), locale),
  );
}

/**
 * The current time in ms, re-rendering once per second while mounted. Mount it only where a
 * countdown is shown: the clock starts fresh at mount, so no immediate tick is needed.
 */
export function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => {
      clearInterval(timer);
    };
  }, []);
  return now;
}

/**
 * Whole seconds left until `deadlineMs`, rounded up, re-rendering once per second while any are
 * left and not at all afterwards (an unreadable deadline counts as passed).
 */
export function useSecondsUntil(deadlineMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  const open = now < deadlineMs;
  useEffect(() => {
    if (!open) return undefined;
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => {
      clearInterval(timer);
    };
  }, [open]);
  return open ? Math.ceil((deadlineMs - now) / 1000) : 0;
}
