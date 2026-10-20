// One import per weight: the packages' index would bundle all of their weights (about 4 MB).
import { Mukta_400Regular } from '@expo-google-fonts/mukta/400Regular';
import { Mukta_500Medium } from '@expo-google-fonts/mukta/500Medium';
import { Mukta_600SemiBold } from '@expo-google-fonts/mukta/600SemiBold';
import { Mukta_700Bold } from '@expo-google-fonts/mukta/700Bold';
import { Outfit_600SemiBold } from '@expo-google-fonts/outfit/600SemiBold';
import { Outfit_700Bold } from '@expo-google-fonts/outfit/700Bold';
import { useFonts } from 'expo-font';

import fonts from './fonts.json';

/**
 * The design system's two families: Outfit for the logo, display text and large figures; Mukta
 * (which covers Devanagari as well as Latin) for headings and body text in English and Nepali.
 * fonts.json names each file once; tailwind.config.js turns the names into `font-*` classes.
 */
export const fontFamilies = fonts.fontFamilies;
export type FontRole = keyof typeof fontFamilies;

const FONT_FILES = {
  Outfit_600SemiBold,
  Outfit_700Bold,
  Mukta_400Regular,
  Mukta_500Medium,
  Mukta_600SemiBold,
  Mukta_700Bold,
} as const;

/**
 * Loads the fonts once, from the root layout. Nothing waits for it: the boot splash covers the
 * first second, and a font that fails to load leaves the system font in its place.
 */
export function useBrandFonts(): boolean {
  const [loaded, error] = useFonts(FONT_FILES);
  return loaded || error !== null;
}
