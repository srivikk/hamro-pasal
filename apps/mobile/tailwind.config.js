/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./app/**/*.{ts,tsx}', './src/**/*.{ts,tsx}'],
  presets: [require('nativewind/preset')],
  theme: {
    extend: {
      colors: {
        // Keep in sync with src/theme/colors.ts (used where a raw colour value is required).
        brand: { DEFAULT: '#C8102E', dark: '#9E0C24', light: '#FDE8EB' },
      },
    },
  },
  plugins: [],
};
