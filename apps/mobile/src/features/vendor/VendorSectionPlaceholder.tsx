import Ionicons from '@expo/vector-icons/Ionicons';
import type { ComponentProps } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { colors } from '../../theme/colors';

interface VendorSectionPlaceholderProps {
  testID: string;
  icon: ComponentProps<typeof Ionicons>['name'];
  title: string;
  body: string;
  /** What the section will hold, one line each. */
  items?: readonly string[];
}

/**
 * The body of a Vendor App section whose screens are not built yet (Catalogue, Marketing,
 * Invoices). It names the section and what will live there, so the navigation can be laid out and
 * tried before each feature lands. Replace the whole screen, not this component, when building one.
 */
export function VendorSectionPlaceholder({
  testID,
  icon,
  title,
  body,
  items = [],
}: VendorSectionPlaceholderProps) {
  const { t } = useTranslation();
  return (
    <ScrollView
      testID={testID}
      className="flex-1 bg-gray-50"
      contentContainerStyle={{ padding: 16, gap: 16 }}
    >
      <View className="items-center gap-3 rounded-2xl bg-white p-6 shadow-sm">
        <Ionicons name={icon} size={40} color={colors.brand} />
        <Text className="text-center text-xl font-bold text-gray-900">{title}</Text>
        <Text className="text-center text-base text-gray-500">{body}</Text>
      </View>
      {items.length > 0 ? (
        <View className="gap-2 rounded-2xl bg-white p-4 shadow-sm">
          {items.map((item) => (
            <View key={item} className="flex-row items-center gap-3">
              <Ionicons name="ellipse" size={8} color={colors.inactive} />
              <Text className="flex-1 text-base text-gray-700">{item}</Text>
            </View>
          ))}
        </View>
      ) : null}
      <Text className="text-center text-sm text-gray-500">{t('vendorTabs.comingSoon')}</Text>
    </ScrollView>
  );
}
