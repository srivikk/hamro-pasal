import Ionicons from '@expo/vector-icons/Ionicons';
import type { FeedEntry } from '@hamro-pasal/shared-types';
import { Image, Pressable, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { vendorExtras } from '../features/promo/mock-promotions';
import { deliveryWindow } from '../features/promo/promo-model';
import { selectHasSession, useAuthStore } from '../store/useAuthStore';
import { useFavouritesStore } from '../store/useFavouritesStore';
import { useToastStore } from '../store/useToastStore';
import { colors } from '../theme/colors';
import { RatingSummary } from './RatingPill';

export interface VendorCardProps {
  entry: FeedEntry;
  /** Ignored for unserviceable vendors: their carts are disabled (SPEC customer flow step 3). */
  onPress?: (vendorId: string) => void;
}

/** One decimal place is enough for "x km away" and keeps Devanagari output short. */
export function roundKm(km: number): number {
  return Math.round(km * 10) / 10;
}

/**
 * A shop in the feed: a cover with a heart to save the shop (signed-in customers only), then the name with its rating, the
 * delivery time and distance with the running offer as a small tag beside them, and the delivery
 * terms. Whatever the shop has no value for (cover, rating, offer, time) is simply left out.
 */
export function VendorCard({ entry, onPress }: VendorCardProps) {
  const { t } = useTranslation();
  const { vendor, serviceable } = entry;
  const interactive = serviceable && onPress !== undefined;
  const extras = vendorExtras(vendor);
  // A delivery time is only promised where the shop delivers.
  const eta = serviceable ? deliveryWindow(extras.prep_minutes, entry.distance_km) : null;
  const favourite = useFavouritesStore((state) => state.favourites[vendor.id] !== undefined);
  const toggleFavourite = useFavouritesStore((state) => state.toggleFavourite);
  const showToast = useToastStore((state) => state.show);
  // Favourites belong to an account: a guest sees no heart.
  const signedIn = useAuthStore(selectHasSession);

  const scopeLabel =
    vendor.delivery_scope === 'RADIUS_BOUND'
      ? t('vendor.scope.RADIUS_BOUND', { radius: vendor.radius_km })
      : vendor.delivery_scope === 'CITY_WIDE'
        ? t('vendor.scope.CITY_WIDE', { palika: vendor.municipality_palika_string })
        : t('vendor.scope.NATION_WIDE');

  // Desaturated palette for Explore Further: grey text and reduced opacity.
  const muted = !serviceable;

  return (
    <Pressable
      testID={`vendor-card-${vendor.id}`}
      accessibilityRole={interactive ? 'button' : undefined}
      accessibilityState={{ disabled: !interactive }}
      disabled={!interactive}
      onPress={() => {
        if (interactive) onPress(vendor.id);
      }}
      className={`mx-4 mb-4 rounded-2xl bg-white shadow-sm ${
        muted ? 'opacity-60' : 'active:opacity-90'
      }`}
    >
      {/* The cover clips its own corners: clipping the card itself would cut its shadow on iOS. */}
      <View
        className={`items-center justify-center overflow-hidden rounded-t-2xl bg-brand-light ${
          extras.cover_image_url === null ? 'h-24' : 'h-40'
        }`}
        testID={`vendor-cover-${vendor.id}`}
      >
        {extras.cover_image_url === null ? (
          <Ionicons name="storefront" size={36} color={colors.brand} />
        ) : (
          <Image
            source={{ uri: extras.cover_image_url }}
            className="h-full w-full"
            resizeMode="cover"
          />
        )}
        {/* Save the shop without opening it. Its own press target: the card around it is not
            pressed, and it works on a shop that does not deliver here too. */}
        {signedIn ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={favourite ? t('favourites.remove') : t('favourites.add')}
            accessibilityState={{ selected: favourite }}
            testID={`vendor-favourite-${vendor.id}`}
            hitSlop={8}
            className="absolute right-2 top-2 z-10 h-9 w-9 items-center justify-center rounded-full bg-white shadow-sm active:bg-gray-100"
            onPress={() => {
              const saved = toggleFavourite({
                vendorId: vendor.id,
                name: vendor.business_name,
                location: [extras.locality, vendor.municipality_palika_string]
                  .filter((part) => part !== null && part !== '')
                  .join(', '),
              });
              showToast(t(saved ? 'favourites.added' : 'favourites.removed'), 'info');
            }}
          >
            <Ionicons
              name={favourite ? 'heart' : 'heart-outline'}
              size={18}
              color={favourite ? colors.brand : '#111827'}
            />
          </Pressable>
        ) : null}
        {/* Step 7.3: closed by its hours, its switch or Auto-Pause; it can still be browsed. */}
        {!entry.open_now ? (
          <View
            testID={`vendor-closed-${vendor.id}`}
            className="absolute bottom-3 left-3 rounded-md bg-gray-900/80 px-2 py-0.5"
          >
            <Text className="text-xs font-bold text-white">{t('vendor.closedNow')}</Text>
          </View>
        ) : null}
        {entry.is_sponsored || extras.is_sponsored ? (
          // Paid placement must be recognisable as such: a small, quiet label on the cover.
          <View
            accessible
            accessibilityLabel={t('vendor.sponsoredLabel')}
            testID={`vendor-ad-${vendor.id}`}
            className="absolute left-3 top-3 rounded-md bg-black/60 px-1.5 py-0.5"
          >
            <Text className="text-[10px] font-bold uppercase tracking-wide text-white">
              {t('vendor.sponsored')}
            </Text>
          </View>
        ) : null}
      </View>

      <View className="p-4">
        <View className="flex-row items-center justify-between gap-2">
          <Text
            className={`flex-1 text-lg font-bold ${muted ? 'text-gray-500' : 'text-gray-900'}`}
            numberOfLines={1}
          >
            {vendor.business_name}
          </Text>
          {extras.rating_average === null ? null : (
            <RatingSummary
              rating={extras.rating_average}
              count={extras.rating_count}
              testID={`vendor-rating-${vendor.id}`}
            />
          )}
        </View>

        <View className="mt-1 flex-row flex-wrap items-center gap-1.5">
          {eta === null ? null : (
            <>
              <Ionicons name="time-outline" size={14} color={colors.inactive} />
              <Text
                className="text-sm font-semibold text-gray-700"
                testID={`vendor-eta-${vendor.id}`}
              >
                {t('vendor.deliveryTime', eta)}
              </Text>
              <Text className="text-sm text-gray-400">·</Text>
            </>
          )}
          <Text className={`text-sm ${muted ? 'text-gray-400' : 'text-gray-500'}`}>
            {t('vendor.distance', { distance: roundKm(entry.distance_km) })}
          </Text>
          {/* The running offer: a small tag beside the delivery details. A label only. */}
          {extras.top_offer === null ? null : (
            <View className="flex-row items-center gap-1 rounded-sm bg-red-50 px-2 py-1">
              <Ionicons name="pricetag" size={10} color={colors.brand} />
              <Text
                className="text-xs font-semibold text-red-600"
                numberOfLines={1}
                testID={`vendor-offer-${vendor.id}`}
              >
                {extras.top_offer}
              </Text>
            </View>
          )}
        </View>

        <Text className={`mt-1 text-xs ${muted ? 'text-gray-400' : 'text-gray-500'}`}>
          {scopeLabel}
        </Text>
        <View className="mt-0.5 flex-row gap-3">
          <Text className={`text-xs ${muted ? 'text-gray-400' : 'text-gray-500'}`}>
            {t('vendor.deliveryFee', { amount: vendor.base_delivery_fee_npr })}
          </Text>
          <Text className={`text-xs ${muted ? 'text-gray-400' : 'text-gray-500'}`}>
            {t('vendor.minOrder', { amount: vendor.min_order_value })}
          </Text>
        </View>

        {muted ? (
          <View className="mt-3 self-start rounded-full bg-gray-200 px-3 py-1">
            <Text className="text-xs font-semibold text-gray-500">{t('vendor.unavailable')}</Text>
          </View>
        ) : null}
      </View>
    </Pressable>
  );
}
