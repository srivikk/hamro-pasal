import { useEffect, useState } from 'react';

/** How often the clock is read; the returned value still changes only once a minute. */
const MINUTE_CHECK_MS = 15_000;

const minuteOf = (ms: number): number => Math.floor(ms / 60_000);

/**
 * The current time in ms, refreshed when the wall-clock minute changes. The cards show
 * "n min ago", so they need a new value once a minute, not once a second: between minutes the
 * state does not change and nothing re-renders. An age can therefore read up to a minute low,
 * never high.
 */
export function useMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => {
      setNow((previous) => (minuteOf(Date.now()) === minuteOf(previous) ? previous : Date.now()));
    }, MINUTE_CHECK_MS);
    return () => {
      clearInterval(timer);
    };
  }, []);
  return now;
}
