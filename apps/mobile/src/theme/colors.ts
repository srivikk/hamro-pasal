import palette from './palette.json';

/**
 * Step 7.9: the colour tokens, light and dark. palette.json is the single source: tailwind.config.js
 * builds the classes from it (`bg-brand`, `bg-surface dark:bg-surface-dark`, `text-ink-muted`...),
 * app.config.ts takes the splash, adaptive-icon and notification colours from it, and this file
 * gives the raw values for APIs that cannot take a className (tab bar tint, icons, gradients).
 */
export { palette };

export const colors = {
  brand: palette.brand.DEFAULT,
  brandDark: palette.brand.dark,
  brandLight: palette.brand.light,
  success: palette.success.DEFAULT,
  warning: palette.warning.DEFAULT,
  danger: palette.danger.DEFAULT,
  inactive: palette.inactive.DEFAULT,
} as const;

/** Surfaces, text and borders for each colour scheme (Profile → Appearance, or the OS). */
export const schemeColors = {
  light: {
    surface: palette.surface.DEFAULT,
    surfaceMuted: palette.surface.muted,
    text: palette.ink.DEFAULT,
    textMuted: palette.ink.muted,
    border: palette.line.DEFAULT,
  },
  dark: {
    surface: palette.surface.dark,
    surfaceMuted: palette.surface['dark-muted'],
    text: palette.ink.dark,
    textMuted: palette.ink['dark-muted'],
    border: palette.line.dark,
  },
} as const;

export type ColorSchemeName = keyof typeof schemeColors;
