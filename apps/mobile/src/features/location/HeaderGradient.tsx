import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { LinearGradient } from '../../lib/optional-linear-gradient';
import {
  HEADER_THEMES,
  HeaderToneProvider,
  useHeaderPhase,
  type HeaderPhase,
  type HeaderTheme,
} from './header-phase';

// A dev client built before expo-linear-gradient was added gets flat bands of the same colours
// (see lib/optional-linear-gradient).
function Background({ theme }: { theme: HeaderTheme }) {
  if (LinearGradient !== null) {
    return (
      <LinearGradient
        colors={theme.colors}
        locations={theme.locations}
        style={StyleSheet.absoluteFill}
        testID="header-gradient"
      />
    );
  }
  return (
    <View style={StyleSheet.absoluteFill} testID="header-gradient-fallback">
      {theme.colors.map((color, index) => (
        // Colours can repeat in a theme, so the position is part of the key.
        <View
          key={`${String(index)}-${color}`}
          className="flex-1"
          style={{ backgroundColor: color }}
        />
      ))}
    </View>
  );
}

/**
 * The night sky's stars: small white dots at fixed places in the upper part of the header. Plain
 * views, no image and no SVG. The classes are written out in full (never built from pieces) so
 * Tailwind finds each one; the positions are percentages, so they spread with the screen width.
 */
const STARS = [
  'left-[6%] top-[14%] h-0.5 w-0.5 opacity-90',
  'left-[14%] top-[38%] h-1 w-1 opacity-60',
  'left-[22%] top-[8%] h-0.5 w-0.5 opacity-70',
  'left-[31%] top-[26%] h-1 w-1 opacity-90',
  'left-[39%] top-[12%] h-0.5 w-0.5 opacity-50',
  'left-[46%] top-[40%] h-0.5 w-0.5 opacity-80',
  'left-[53%] top-[6%] h-1 w-1 opacity-70',
  'left-[60%] top-[30%] h-0.5 w-0.5 opacity-90',
  'left-[67%] top-[16%] h-1 w-1 opacity-50',
  'left-[73%] top-[44%] h-0.5 w-0.5 opacity-70',
  'left-[79%] top-[10%] h-0.5 w-0.5 opacity-90',
  'left-[85%] top-[34%] h-1 w-1 opacity-60',
  'left-[91%] top-[20%] h-0.5 w-0.5 opacity-80',
  'left-[96%] top-[48%] h-0.5 w-0.5 opacity-60',
] as const;

export function Stars() {
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none" testID="header-stars">
      {STARS.map((placement) => (
        <View
          key={placement}
          testID="header-star"
          className={`absolute rounded-full bg-white ${placement}`}
        />
      ))}
    </View>
  );
}

/**
 * The block at the top of Home: a gradient that follows the time of day (morning, afternoon,
 * evening, night), running under the status bar (the stack header is off for this screen), with
 * the location row and the search bar on it. At night it adds stars, and tells what is drawn on
 * it (through HeaderToneProvider) to use light text.
 *
 * `phase` overrides the clock (tests, previews).
 */
export function HeaderGradient({ children, phase }: { children: ReactNode; phase?: HeaderPhase }) {
  const { top } = useSafeAreaInsets();
  const clockPhase = useHeaderPhase();
  const current = phase ?? clockPhase;
  const theme = HEADER_THEMES[current];
  return (
    <View style={{ paddingTop: top }} testID="home-header" accessibilityLabel={current}>
      <Background theme={theme} />
      {current === 'night' ? <Stars /> : null}
      <HeaderToneProvider value={theme.tone}>{children}</HeaderToneProvider>
    </View>
  );
}
