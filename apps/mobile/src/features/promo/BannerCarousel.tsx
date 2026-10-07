import { useEffect, useRef, useState } from 'react';
import { Image, Pressable, ScrollView, Text, View, useWindowDimensions } from 'react-native';
import { useTranslation } from 'react-i18next';

import { ImageScrim } from '../../components/ImageScrim';
import { promoTarget, type PromoBanner, type PromoTarget } from './promo-model';

/** How long a banner stays before the carousel moves to the next one. */
export const BANNER_INTERVAL_MS = 4000;

/**
 * The admin's banners as a full-width paging carousel that advances by itself and wraps around.
 * It stops advancing while the customer is dragging it. With no banner it renders nothing, so
 * Home keeps its plain layout.
 */
export function BannerCarousel({
  banners,
  onOpen,
}: {
  banners: readonly PromoBanner[];
  /** Called for a banner that leads somewhere; a banner without a target is not pressable. */
  onOpen: (target: PromoTarget) => void;
}) {
  const { t } = useTranslation();
  const { width } = useWindowDimensions();
  const scroll = useRef<ScrollView>(null);
  // The page the carousel is on, kept in a ref for the timer and in state for the dots.
  const page = useRef(0);
  const dragging = useRef(false);
  const [active, setActive] = useState(0);
  const count = banners.length;

  useEffect(() => {
    if (count < 2) return undefined;
    const timer = setInterval(() => {
      if (dragging.current) return;
      page.current = (page.current + 1) % count;
      scroll.current?.scrollTo({ x: page.current * width, animated: true });
    }, BANNER_INTERVAL_MS);
    return () => {
      clearInterval(timer);
    };
  }, [count, width]);

  if (count === 0) return null;

  return (
    <View className="pt-4" testID="banner-carousel">
      <ScrollView
        ref={scroll}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        scrollEventThrottle={16}
        testID="banner-scroll"
        onScrollBeginDrag={() => {
          dragging.current = true;
        }}
        onScrollEndDrag={() => {
          dragging.current = false;
        }}
        onScroll={({ nativeEvent }) => {
          const current = Math.round(nativeEvent.contentOffset.x / width);
          if (current === page.current && current === active) return;
          page.current = current;
          setActive(current);
        }}
      >
        {banners.map((banner) => {
          const target = promoTarget(banner);
          return (
            <View key={banner.id} style={{ width }} className="px-4">
              <Pressable
                testID={`banner-${banner.id}`}
                accessibilityRole={target === null ? 'image' : 'button'}
                accessibilityLabel={banner.title ?? t('promo.banner')}
                disabled={target === null}
                className="h-40 overflow-hidden rounded-2xl bg-brand-light"
                onPress={() => {
                  if (target !== null) onOpen(target);
                }}
              >
                <Image
                  source={{ uri: banner.image_url }}
                  className="h-full w-full"
                  resizeMode="cover"
                />
                {banner.title === null ? null : (
                  <>
                    <ImageScrim />
                    <View className="absolute bottom-0 left-0 right-0 p-4">
                      <Text className="text-xl font-extrabold text-white" numberOfLines={1}>
                        {banner.title}
                      </Text>
                      {banner.subtitle === null ? null : (
                        <Text className="mt-0.5 text-sm text-white" numberOfLines={1}>
                          {banner.subtitle}
                        </Text>
                      )}
                    </View>
                  </>
                )}
              </Pressable>
            </View>
          );
        })}
      </ScrollView>
      {count < 2 ? null : (
        <View className="mt-2 flex-row justify-center gap-1.5" testID="banner-dots">
          {banners.map((banner, index) => (
            <View
              key={banner.id}
              testID={index === active ? 'banner-dot-active' : 'banner-dot'}
              className={`h-1.5 rounded-full ${index === active ? 'w-4 bg-brand' : 'w-1.5 bg-gray-300'}`}
            />
          ))}
        </View>
      )}
    </View>
  );
}
