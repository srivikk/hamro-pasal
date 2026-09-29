import { useEffect, useState } from 'react';

/** setTimeout stores delays as a signed 32-bit int; longer delays would fire immediately. */
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

/**
 * True while the current time is before `deadlineMs`, flipping to false at the deadline without
 * a per-second clock: one timer is scheduled for the moment the window closes.
 */
export function useBeforeDeadline(deadlineMs: number | null): boolean {
  const [now, setNow] = useState(() => Date.now());
  const open = deadlineMs !== null && now < deadlineMs;

  useEffect(() => {
    if (!open) return undefined;
    const timer = setTimeout(
      () => {
        setNow(Date.now());
      },
      Math.min(deadlineMs - now, MAX_TIMEOUT_MS),
    );
    return () => {
      clearTimeout(timer);
    };
  }, [open, deadlineMs, now]);

  return open;
}
