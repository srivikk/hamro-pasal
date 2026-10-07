import { colorScheme } from 'nativewind';

import type { AppTheme } from '../store/useThemeStore';

/**
 * Hands the chosen theme to NativeWind, which sets it on React Native's Appearance: every
 * `dark:` class, the navigation theme and the status bar follow from that one call.
 * Never throws: a theme that cannot be applied leaves the app in its current colours.
 */
export function applyTheme(theme: AppTheme): void {
  try {
    colorScheme.set(theme);
  } catch (error) {
    console.warn(`[theme] could not apply "${theme}": ${String(error)}`);
  }
}

/** Applies the persisted theme now and on every change. Returns the unsubscribe. */
export function bindTheme(store: {
  getState: () => { theme: AppTheme };
  subscribe: (
    listener: (state: { theme: AppTheme }, previous: { theme: AppTheme }) => void,
  ) => () => void;
}): () => void {
  applyTheme(store.getState().theme);
  return store.subscribe(({ theme }, previous) => {
    if (theme !== previous.theme) applyTheme(theme);
  });
}
