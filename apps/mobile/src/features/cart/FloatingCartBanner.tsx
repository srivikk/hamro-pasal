import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Animated, Pressable, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { useCartStore, useCartTotal, useItemCount } from '../../store/useCartStore';

/** Mounted only while the cart has items, so it slides in each time the first item is added. */
function Banner() {
  const { t } = useTranslation();
  const itemCount = useItemCount();
  const totalNpr = useCartTotal();
  const [entrance] = useState(() => new Animated.Value(0));

  useEffect(() => {
    const slideIn = Animated.timing(entrance, {
      toValue: 1,
      duration: 220,
      useNativeDriver: true,
    });
    slideIn.start();
    return () => {
      slideIn.stop();
    };
  }, [entrance]);

  return (
    <Animated.View
      style={{
        opacity: entrance,
        transform: [
          { translateY: entrance.interpolate({ inputRange: [0, 1], outputRange: [24, 0] }) },
        ],
      }}
    >
      <View className="bg-gray-50 px-3 pb-2 pt-1">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('cartBanner.label', { items: itemCount, amount: totalNpr })}
          testID="cart-banner"
          className="flex-row items-center justify-between rounded-xl bg-green-700 px-4 py-3 shadow-sm active:bg-green-800"
          onPress={() => {
            router.push('/cart');
          }}
        >
          <Text className="text-sm font-bold text-white" testID="cart-banner-summary">
            {t('cart.itemCount', { count: itemCount })}
            {'  |  '}
            {t('common.price', { amount: totalNpr })}
          </Text>
          <View className="flex-row items-center gap-1">
            <Text className="text-sm font-extrabold text-white">{t('cartBanner.view')}</Text>
            <Ionicons name="chevron-forward" size={16} color="#FFFFFF" />
          </View>
        </Pressable>
      </View>
    </Animated.View>
  );
}

/**
 * The green "2 items | Rs. 900 · View Cart >" bar. It sits under the Shops tab's stack (the feed
 * and a shop's page) and above the tab bar, in the layout's own flow, so it covers no content.
 * Nothing is rendered for an empty cart.
 */
export function FloatingCartBanner() {
  const hasItems = useCartStore((state) => state.lines.length > 0);
  return hasItems ? <Banner /> : null;
}
