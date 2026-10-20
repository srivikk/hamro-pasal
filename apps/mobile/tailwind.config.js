// Step 7.9: every colour token comes from src/theme/palette.json (also read by src/theme/colors.ts
// and app.config.ts), so the classes, raw values and native assets cannot drift apart.
// "Sajilo cha hai" design system (2026-10-21): the palette, the fonts and the radii below are the
// whole system; src/ui/ builds the shared components on them.
const palette = require('./src/theme/palette.json');
const { fontFamilies } = require('./src/theme/fonts.json');

/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./app/**/*.{ts,tsx}', './src/**/*.{ts,tsx}'],
  presets: [require('nativewind/preset')],
  // Profile → Appearance sets the theme by hand (NativeWind's colorScheme API), not only the OS.
  // Pair the light and dark tokens: `bg-surface dark:bg-surface-dark`, `text-ink dark:text-ink-dark`.
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        ...palette,
        // Screens were laid out on `bg-gray-50`; the design system's warm background replaces it, so
        // every screen moves to the new canvas without rewriting 50 class names.
        gray: { 50: palette.canvas.DEFAULT },
      },
      // React Native picks a font file per family name (a weight is its own family), so each class
      // names one file: `font-display` (Outfit, logos and big numbers), `font-heading` (Mukta bold,
      // H1 / H2), `font-body` / `font-body-medium` / `font-body-semibold` (Mukta, English and Nepali).
      // Do not add `font-bold` beside them: Android would fake a bold of the regular file.
      fontFamily: Object.fromEntries(
        Object.entries(fontFamilies).map(([name, family]) => [name, [family]]),
      ),
      borderRadius: {
        // Cards are 16 px, the large feature cards (banners, the seller's summary) 20 px.
        card: '16px',
        'card-lg': '20px',
      },
    },
  },
  plugins: [],
};
