import { Pressable, Text } from 'react-native';

export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'destructive';
export type ButtonSize = 'md' | 'sm';

export interface ButtonProps {
  /** Already-translated text; callers pass `t('...')`. */
  label: string;
  onPress: () => void;
  variant?: ButtonVariant;
  size?: ButtonSize;
  disabled?: boolean;
  /** Screen-reader text when the visible label alone is ambiguous (e.g. "+"). */
  accessibilityLabel?: string;
  testID?: string;
}

const containerByVariant: Record<ButtonVariant, string> = {
  primary: 'bg-brand active:bg-brand-dark',
  secondary: 'border border-gray-300 bg-white active:bg-gray-100',
  danger: 'bg-red-50 active:bg-red-100',
  // Solid red: an action that cannot be undone (delete account).
  destructive: 'bg-red-600 active:bg-red-700',
};

const labelByVariant: Record<ButtonVariant, string> = {
  primary: 'text-white',
  secondary: 'text-gray-900',
  danger: 'text-red-700',
  destructive: 'text-white',
};

const containerBySize: Record<ButtonSize, string> = {
  md: 'min-h-12 px-5 py-3',
  sm: 'min-h-9 min-w-9 px-3 py-1.5',
};

const labelBySize: Record<ButtonSize, string> = {
  md: 'text-base',
  sm: 'text-sm',
};

export function Button({
  label,
  onPress,
  variant = 'primary',
  size = 'md',
  disabled = false,
  accessibilityLabel,
  testID,
}: ButtonProps) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      testID={testID}
      className={`items-center justify-center rounded-xl ${containerBySize[size]} ${containerByVariant[variant]} ${disabled ? 'opacity-40' : ''}`}
    >
      <Text className={`font-semibold ${labelBySize[size]} ${labelByVariant[variant]}`}>
        {label}
      </Text>
    </Pressable>
  );
}
