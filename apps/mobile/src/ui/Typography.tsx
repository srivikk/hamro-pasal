import type { ReactNode } from 'react';
import { Text, type TextProps } from 'react-native';

/*
 * "Sajilo cha hai" type scale. Outfit is the brand face (logo, display text, large figures);
 * Mukta carries headings and body copy in English and Nepali. Each component sets one font file
 * (see tailwind.config.js), so never add `font-bold` to them: pick the component instead.
 */

interface TypeProps extends TextProps {
  children: ReactNode;
  /** Extra classes (colour, alignment, margins). The font and size come from the component. */
  className?: string;
}

/** Brand display: screen hero titles, the wordmark, big amounts. Outfit Bold. */
export function Display({ className = '', ...props }: TypeProps) {
  return (
    <Text
      accessibilityRole="header"
      className={`font-display text-3xl text-ink dark:text-ink-dark ${className}`}
      {...props}
    />
  );
}

/** H1: a screen's main heading. Mukta Bold. */
export function H1({ className = '', ...props }: TypeProps) {
  return (
    <Text
      accessibilityRole="header"
      className={`font-heading text-2xl text-ink dark:text-ink-dark ${className}`}
      {...props}
    />
  );
}

/** H2: a section heading ("Delivers to you", "Real-time active orders"). Mukta Bold. */
export function H2({ className = '', ...props }: TypeProps) {
  return (
    <Text
      accessibilityRole="header"
      className={`font-heading text-lg text-ink dark:text-ink-dark ${className}`}
      {...props}
    />
  );
}

/** Body copy. Mukta Regular, or `weight="medium" | "semibold"` for emphasis. */
export function Body({
  className = '',
  weight = 'regular',
  muted = false,
  ...props
}: TypeProps & { weight?: 'regular' | 'medium' | 'semibold'; muted?: boolean }) {
  const font =
    weight === 'semibold'
      ? 'font-body-semibold'
      : weight === 'medium'
        ? 'font-body-medium'
        : 'font-body';
  const color = muted ? 'text-ink-muted dark:text-ink-dark-muted' : 'text-ink dark:text-ink-dark';
  return <Text className={`${font} text-base ${color} ${className}`} {...props} />;
}

/** Small print: captions, meta lines, chips. Mukta Medium, muted. */
export function Caption({ className = '', ...props }: TypeProps) {
  return (
    <Text
      className={`font-body-medium text-xs text-ink-muted dark:text-ink-dark-muted ${className}`}
      {...props}
    />
  );
}
