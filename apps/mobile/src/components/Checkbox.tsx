import Ionicons from '@expo/vector-icons/Ionicons';
import type { ReactNode } from 'react';
import { Pressable, View } from 'react-native';

/** A labelled tick box. The whole row is the press target; `children` is the label. */
export function Checkbox({
  checked,
  onChange,
  accessibilityLabel,
  invalid = false,
  testID,
  children,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  accessibilityLabel: string;
  /** Draws the box in red: a required box that was left empty. */
  invalid?: boolean;
  testID: string;
  children: ReactNode;
}) {
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ checked }}
      testID={testID}
      hitSlop={6}
      className="flex-row items-start gap-3"
      onPress={() => {
        onChange(!checked);
      }}
    >
      <View
        className={`mt-0.5 h-6 w-6 items-center justify-center rounded-md border-2 ${
          checked
            ? 'border-brand bg-brand'
            : invalid
              ? 'border-red-600 bg-white dark:bg-gray-900'
              : 'border-gray-400 bg-white dark:bg-gray-900'
        }`}
      >
        {checked ? <Ionicons name="checkmark" size={16} color="#FFFFFF" /> : null}
      </View>
      <View className="flex-1">{children}</View>
    </Pressable>
  );
}
