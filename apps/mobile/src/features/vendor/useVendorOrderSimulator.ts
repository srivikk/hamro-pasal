import { useEffect, useState } from 'react';

import { useVendorBoardStore } from '../../store/useVendorBoardStore';
import { MOCK_ORDER_INTERVAL_MS } from './vendor-order-mocks';

/**
 * TEMPORARY (development builds): while `enabled`, seeds the board once and then lets a sample
 * order arrive every 30 seconds, as a busy shop would see them. Disabling it (the shop goes
 * offline, the screen closes) stops the arrivals and leaves the orders already there.
 */
export function useVendorOrderSimulator(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return undefined;
    useVendorBoardStore.getState().seedMocks(Date.now());
    const timer = setInterval(() => {
      useVendorBoardStore.getState().addIncomingMock(Date.now());
    }, MOCK_ORDER_INTERVAL_MS);
    return () => {
      clearInterval(timer);
    };
  }, [enabled]);
}

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
