import Ionicons from '@expo/vector-icons/Ionicons';
import { Image, Pressable, ScrollView, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { colors } from '../../theme/colors';
import { promoTarget, type FeaturedOffer, type PromoTarget } from './promo-model';

/**
 * "Featured offers": the admin's offers as a horizontal row of square tiles. With no offer it
 * renders nothing (no heading either).
 */
export function FeaturedOffers({
  offers,
  onOpen,
}: {
  offers: readonly FeaturedOffer[];
  /** Called for an offer that leads somewhere; an offer without a target is not pressable. */
  onOpen: (target: PromoTarget) => void;
}) {
  const { t } = useTranslation();
  if (offers.length === 0) return null;

  return (
    <View className="pt-4" testID="featured-offers">
      <Text className="px-4 pb-3 text-lg font-bold text-gray-900">{t('promo.offersTitle')}</Text>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ paddingHorizontal: 16, gap: 12 }}
      >
        {offers.map((offer) => {
          const target = promoTarget(offer);
          return (
            <Pressable
              key={offer.id}
              testID={`offer-${offer.id}`}
              accessibilityRole={target === null ? 'text' : 'button'}
              accessibilityLabel={
                offer.subtitle === null ? offer.title : `${offer.title}, ${offer.subtitle}`
              }
              disabled={target === null}
              className="w-28 active:opacity-70"
              onPress={() => {
                if (target !== null) onOpen(target);
              }}
            >
              <View className="h-28 w-28 items-center justify-center overflow-hidden rounded-2xl bg-brand-light">
                {offer.image_url === null ? (
                  <Ionicons name="pricetags" size={32} color={colors.brand} />
                ) : (
                  <Image
                    source={{ uri: offer.image_url }}
                    className="h-full w-full"
                    resizeMode="cover"
                  />
                )}
              </View>
              <Text className="mt-2 text-sm font-bold text-gray-900" numberOfLines={1}>
                {offer.title}
              </Text>
              {offer.subtitle === null ? null : (
                <Text className="text-xs text-gray-500" numberOfLines={1}>
                  {offer.subtitle}
                </Text>
              )}
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}
