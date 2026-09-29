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

/** Re-renders once per second while `active`, returning the current time in ms. */
export function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    const tick = (): void => {
      setNow(Date.now());
    };
    // First tick right away (the clock may be stale if the countdown just became active).
    const first = setTimeout(tick, 0);
    const timer = setInterval(tick, 1000);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [active]);
  return now;
}
