import { useEffect } from 'react';
import { Image, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import Animated, {
  Easing,
  cancelAnimation,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';

import { isSellerApp } from '../lib/app-variant';

/*
 * Brand artwork from the approved "Sajilo cha hai" mockups (2026-10-21): the customer emblem (a
 * Nepali shop under the Himalaya) and the Seller app's "Hamro Pasal Vendor" art, both in
 * assets/branding/<variant>/logo.png, and the basket of the loading screen. The wordmark is drawn
 * as text (Outfit), so it stays sharp and follows the language.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const CUSTOMER_LOGO = require('../../assets/branding/customer/logo.png') as number;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const SELLER_LOGO = require('../../assets/branding/seller/logo.png') as number;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const BASKET = require('../../assets/images/basket-loader.png') as number;

/** The app's logo mark for this build. */
export function BrandMark({ size = 112 }: { size?: number }) {
  const { t } = useTranslation();
  const seller = isSellerApp();
  return (
    <Image
      testID="brand-mark"
      accessibilityRole="image"
      accessibilityLabel={seller ? t('boot.sellerName') : t('boot.appName')}
      source={seller ? SELLER_LOGO : CUSTOMER_LOGO}
      resizeMode="contain"
      style={{ width: size, height: size }}
    />
  );
}

/** The mark with "Hamro Pasal" in Outfit and the build's tagline in script beneath it. */
export function BrandLockup({
  size = 140,
  tone = 'brand',
}: {
  size?: number;
  /** `brand`: red name on a light surface; `light`: white text on the red brand colour. */
  tone?: 'brand' | 'light';
}) {
  const { t } = useTranslation();
  const seller = isSellerApp();
  const nameColour = tone === 'light' ? 'text-white' : 'text-brand';
  const taglineColour =
    tone === 'light' ? 'text-white/90' : 'text-ink-muted dark:text-ink-dark-muted';
  return (
    <View className="items-center gap-1" testID="brand-lockup">
      <BrandMark size={size} />
      <Text className={`font-display text-4xl ${nameColour}`}>
        {seller ? t('boot.sellerName') : t('boot.appName')}
      </Text>
      <Text className={`font-body-medium text-lg italic ${taglineColour}`} testID="brand-tagline">
        ~ {seller ? t('boot.sellerTagline') : t('boot.taglineShort')} ~
      </Text>
    </View>
  );
}

/** "Made in Nepal", with the flag's crimson and blue; on every loading screen and About. */
export function MadeInNepal({ className = '' }: { className?: string }) {
  const { t } = useTranslation();
  return (
    <View
      className={`flex-row items-center justify-center gap-2 ${className}`}
      testID="made-in-nepal"
    >
      <View className="h-2 w-2 rounded-full bg-brand" />
      <Text className="font-body-semibold text-xs uppercase tracking-widest text-ink-muted dark:text-ink-dark-muted">
        {t('boot.madeInNepal')}
      </Text>
      <View className="h-2 w-2 rounded-full bg-himalaya" />
    </View>
  );
}

const RING_SPIN_MS = 1200;

/**
 * The basket loader: the basket of goods inside a turning red ring, then "Sajilo cha hai…".
 * The ring holds still when the phone asks for reduced motion.
 */
export function BasketLoader({ size = 120, label = true }: { size?: number; label?: boolean }) {
  const { t } = useTranslation();
  const reduceMotion = useReducedMotion();
  const turn = useSharedValue(0);

  useEffect(() => {
    if (reduceMotion) return undefined;
    turn.value = withRepeat(withTiming(360, { duration: RING_SPIN_MS, easing: Easing.linear }), -1);
    return () => {
      cancelAnimation(turn);
    };
  }, [reduceMotion, turn]);

  const ring = useAnimatedStyle(() => ({ transform: [{ rotate: `${String(turn.value)}deg` }] }));

  return (
    <View
      className="items-center gap-3"
      testID="basket-loader"
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={t('boot.loading')}
    >
      <View style={{ width: size, height: size }} className="items-center justify-center">
        <Animated.View
          style={[
            ring,
            {
              position: 'absolute',
              width: size,
              height: size,
              borderRadius: size / 2,
              borderWidth: 4,
            },
          ]}
          className="border-brand-light border-t-brand border-r-brand"
        />
        <Image
          source={BASKET}
          resizeMode="contain"
          style={{ width: size * 0.72, height: size * 0.72 }}
        />
      </View>
      {label ? (
        <Text className="font-body-medium text-base text-ink-muted dark:text-ink-dark-muted">
          {t('boot.loading')}
        </Text>
      ) : null}
    </View>
  );
}
