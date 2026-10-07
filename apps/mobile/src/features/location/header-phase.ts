import { createContext, useContext, useEffect, useState } from 'react';
import { AppState } from 'react-native';

/** The four looks of the Home header, by the hour on the phone's own clock. */
export type HeaderPhase = 'morning' | 'afternoon' | 'evening' | 'night';

/** Whether the header's text and icons are dark (on a light sky) or light (on the night sky). */
export type HeaderTone = 'dark' | 'light';

export interface HeaderTheme {
  /** Top to bottom. The day phases end on the screen's own background (bg-gray-50). */
  colors: readonly [string, string, ...string[]];
  /** Where each colour sits, 0 (top) to 1 (bottom); one per colour. */
  locations: readonly [number, number, ...number[]];
  tone: HeaderTone;
}

const SCREEN_BACKGROUND = '#F9FAFB';

export const HEADER_THEMES: Record<HeaderPhase, HeaderTheme> = {
  // Soft morning yellow.
  morning: {
    colors: ['#FFE98A', '#FFF6CC', SCREEN_BACKGROUND],
    locations: [0, 0.55, 1],
    tone: 'dark',
  },
  // Bright sunshine yellow into orange.
  afternoon: {
    colors: ['#FFC400', '#FFB347', '#FFE4A8', SCREEN_BACKGROUND],
    locations: [0, 0.35, 0.75, 1],
    tone: 'dark',
  },
  // Sunset: red, orange, pink.
  evening: {
    colors: ['#F2545B', '#FF8C5A', '#FFC1CC', SCREEN_BACKGROUND],
    locations: [0, 0.35, 0.75, 1],
    tone: 'dark',
  },
  // Night sky: deep navy fading down to indigo. Dark all the way, so white text stays legible.
  night: {
    colors: ['#070B24', '#131C4D', '#2A3780'],
    locations: [0, 0.5, 1],
    tone: 'light',
  },
};

/**
 * Morning 05:00–11:59, afternoon 12:00–16:59, evening 17:00–19:59, night 20:00–04:59.
 * `hour` is `Date#getHours()` (0–23, local time).
 */
export function headerPhaseAt(hour: number): HeaderPhase {
  if (hour >= 5 && hour < 12) return 'morning';
  if (hour >= 12 && hour < 17) return 'afternoon';
  if (hour >= 17 && hour < 20) return 'evening';
  return 'night';
}

/** How often the clock is looked at while the app is open. */
const PHASE_CHECK_INTERVAL_MS = 60_000;

/**
 * The current phase, kept up to date: re-read every minute and whenever the app returns to the
 * foreground, so a header left open across 17:00 or 20:00 changes without a restart.
 */
export function useHeaderPhase(now: () => Date = () => new Date()): HeaderPhase {
  const [phase, setPhase] = useState(() => headerPhaseAt(now().getHours()));

  useEffect(() => {
    const read = (): void => {
      setPhase(headerPhaseAt(now().getHours()));
    };
    const timer = setInterval(read, PHASE_CHECK_INTERVAL_MS);
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') read();
    });
    return () => {
      clearInterval(timer);
      subscription.remove();
    };
    // `now` is a test seam; the real clock function never changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return phase;
}

const HeaderToneContext = createContext<HeaderTone>('dark');

/** Provided by HeaderGradient; anything drawn on the gradient reads it to pick its text colour. */
export const HeaderToneProvider = HeaderToneContext.Provider;

/** 'dark' outside a HeaderGradient (a plain light background). */
export function useHeaderTone(): HeaderTone {
  return useContext(HeaderToneContext);
}
