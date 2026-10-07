import Ionicons from '@expo/vector-icons/Ionicons';
import { Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { colors } from '../../theme/colors';

/** How long the splash stays up at least, so it does not flash by on a fast phone. */
export const SPLASH_MIN_DURATION_MS = 1500;

/**
 * PLACEHOLDER for the brand logo: a shop front under two peaks (the Nepal motif). Replace with
 * the real artwork when it exists; nothing else depends on its shape.
 */
export function LogoPlaceholder({ size = 112 }: { size?: number }) {
  return (
    <View
      testID="logo-placeholder"
      accessibilityRole="image"
      accessibilityLabel="Hamro Pasal"
      className="items-center justify-center rounded-full bg-white"
      style={{ width: size, height: size }}
    >
      <View className="flex-row items-end">
        <Ionicons name="triangle" size={size * 0.2} color={colors.brand} />
        <Ionicons name="triangle" size={size * 0.28} color={colors.brand} />
      </View>
      <Ionicons name="storefront" size={size * 0.42} color={colors.brand} />
    </View>
  );
}

/** The boot screen: the logo in the middle, the tagline at the bottom. */
export function SplashView() {
  const { t } = useTranslation();
  return (
    <View className="flex-1 bg-brand" testID="boot-splash">
      <View className="flex-1 items-center justify-center gap-4">
        <LogoPlaceholder />
        <Text className="text-3xl font-bold text-white">{t('boot.appName')}</Text>
      </View>
      <Text className="pb-12 text-center text-base font-semibold text-white" testID="boot-tagline">
        {t('boot.tagline')}
      </Text>
    </View>
  );
}
