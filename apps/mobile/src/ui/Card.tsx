import type { ReactNode } from 'react';
import { Pressable, View, type ViewProps } from 'react-native';

/*
 * Cards are the system's main container: white on the warm canvas, 16 px corners (20 px for the
 * large feature cards), a soft shadow and a hairline warm border. Keep the `shadow-sm` on in every
 * state (see nativewind-shadow-guard.test.ts): vary the border or background instead.
 */

const SIZE = {
  md: 'rounded-card p-4',
  lg: 'rounded-card-lg p-5',
} as const;

interface CardProps extends ViewProps {
  children: ReactNode;
  size?: keyof typeof SIZE;
  className?: string;
  /** When set the whole card is one button. */
  onPress?: () => void;
  accessibilityLabel?: string;
}

const BASE =
  'border border-line bg-surface shadow-sm dark:border-line-dark dark:bg-surface-dark-muted';

export function Card({
  children,
  size = 'md',
  className = '',
  onPress,
  accessibilityLabel,
  testID,
  ...rest
}: CardProps) {
  const classes = `${BASE} ${SIZE[size]} ${className}`;
  if (onPress === undefined) {
    return (
      <View className={classes} testID={testID} {...rest}>
        {children}
      </View>
    );
  }
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      onPress={onPress}
      testID={testID}
      className={`${classes} active:opacity-90`}
    >
      {children}
    </Pressable>
  );
}
