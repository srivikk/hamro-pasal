import { Stack } from 'expo-router';
import { View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { FloatingCartBanner } from '../../../src/features/cart/FloatingCartBanner';
import { TutorialCard } from '../../../src/features/tutorials/TutorialCard';

/**
 * The Shops tab is a stack: the feed, and a shop's menu pushed on top of it. Because the stack
 * lives inside the tab, the bottom tab bar (Shops, Profile) stays visible on a shop's page, and
 * the Shops tab button returns to the feed. Routes are unchanged: `/` and `/vendor/[id]`.
 *
 * The cart banner is mounted once, under the stack and above the tab bar, so it shows on both
 * screens and stays put while one slides over the other.
 */
export default function HomeStackLayout() {
  const { t } = useTranslation();
  return (
    <View className="flex-1 bg-gray-50">
      <View className="flex-1">
        <Stack>
          {/* The feed draws its own header (the gradient with the location and the search bar). */}
          <Stack.Screen name="index" options={{ title: t('tabs.feed'), headerShown: false }} />
          <Stack.Screen name="vendor/[id]" options={{ headerBackTitle: t('common.back') }} />
        </Stack>
      </View>
      <FloatingCartBanner />
      {/* Step 7.8: the customer app's tutorial videos, floating over the feed. */}
      <TutorialCard />
    </View>
  );
}
