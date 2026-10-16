// Step 7.9: every colour token comes from src/theme/palette.json (also read by src/theme/colors.ts
// and app.config.ts), so the classes, raw values and native assets cannot drift apart.
const palette = require('./src/theme/palette.json');

/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./app/**/*.{ts,tsx}', './src/**/*.{ts,tsx}'],
  presets: [require('nativewind/preset')],
  // Profile → Appearance sets the theme by hand (NativeWind's colorScheme API), not only the OS.
  // Pair the light and dark tokens: `bg-surface dark:bg-surface-dark`, `text-ink dark:text-ink-dark`.
  darkMode: 'class',
  theme: {
    extend: {
      colors: palette,
    },
  },
  plugins: [],
};
