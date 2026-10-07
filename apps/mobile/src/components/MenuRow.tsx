import Ionicons from '@expo/vector-icons/Ionicons';
import type { ComponentProps, ReactNode } from 'react';
import { Pressable, Text, View } from 'react-native';

import { colors } from '../theme/colors';

/** One line of a settings menu: leading icon, label (and optional value), trailing chevron. */
export function MenuRow({
  icon,
  label,
  value,
  testID,
  danger = false,
  last = false,
  onPress,
}: {
  icon: ComponentProps<typeof Ionicons>['name'];
  label: string;
  /** The current choice, shown in muted text before the chevron ("English", "Dark"). */
  value?: string;
  testID: string;
  danger?: boolean;
  last?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      testID={testID}
      className="flex-row items-center gap-3 px-4 active:bg-gray-100 dark:active:bg-gray-800"
      onPress={onPress}
    >
      <View className="h-9 w-9 items-center justify-center rounded-full bg-gray-100 dark:bg-gray-800">
        <Ionicons name={icon} size={18} color={danger ? '#DC2626' : colors.inactive} />
      </View>
      <View
        className={`flex-1 flex-row items-center gap-2 py-4 ${
          last ? '' : 'border-b border-gray-100 dark:border-gray-800'
        }`}
      >
        <Text
          className={`flex-1 text-base font-medium ${
            danger ? 'text-red-700 dark:text-red-400' : 'text-gray-900 dark:text-gray-100'
          }`}
        >
          {label}
        </Text>
        {value === undefined ? null : (
          <Text className="text-sm text-gray-500 dark:text-gray-400">{value}</Text>
        )}
        <Ionicons name="chevron-forward" size={18} color={colors.inactive} />
      </View>
    </Pressable>
  );
}

/** A white (dark: charcoal) rounded card holding menu rows. */
export function MenuCard({ children }: { children: ReactNode }) {
  return (
    <View className="overflow-hidden rounded-2xl bg-white shadow-sm dark:bg-gray-900">
      {children}
    </View>
  );
}

export function SectionTitle({ children }: { children: string }) {
  return (
    <Text className="px-1 text-xs font-bold uppercase tracking-wide text-gray-500 dark:text-gray-400">
      {children}
    </Text>
  );
}
