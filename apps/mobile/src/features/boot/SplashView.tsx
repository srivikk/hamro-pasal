import { Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { BasketLoader, BrandLockup, BrandMark, MadeInNepal } from '../../ui';

/** How long the splash stays up at least, so it does not flash by on a fast phone. */
export const SPLASH_MIN_DURATION_MS = 1500;

/**
 * The app's logo mark (the customer emblem, or the Seller app's art). The name and testID are
 * kept from the placeholder this replaced: the Welcome, Language and About screens use it.
 */
export function LogoPlaceholder({ size = 112 }: { size?: number }) {
  return (
    <View testID="logo-placeholder">
      <BrandMark size={size} />
    </View>
  );
}

/** The boot screen: the logo lockup, the basket loader, "Made in Nepal" at the bottom. */
export function SplashView() {
  const { t } = useTranslation();
  return (
    <View className="flex-1 bg-canvas dark:bg-canvas-dark" testID="boot-splash">
      <View className="flex-1 items-center justify-center gap-10">
        <BrandLockup size={160} />
        <BasketLoader size={96} label={false} />
      </View>
      <View className="gap-3 pb-12">
        <Text className="text-center font-body-semibold text-base text-brand" testID="boot-tagline">
          {t('boot.tagline')}
        </Text>
        <MadeInNepal />
      </View>
    </View>
  );
}
