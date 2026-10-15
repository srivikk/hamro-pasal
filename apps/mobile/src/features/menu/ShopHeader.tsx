import Ionicons from '@expo/vector-icons/Ionicons';
import { MAX_PRODUCT_SEARCH_LENGTH } from '@hamro-pasal/shared-types';
import { Image, Pressable, Text, TextInput, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { RatingSummary } from '../../components/RatingPill';
import { RotatingPlaceholder } from '../../components/RotatingPlaceholder';
import { roundKm } from '../../components/VendorCard';
import { selectHasSession, useAuthStore } from '../../store/useAuthStore';
import { useToastStore } from '../../store/useToastStore';
import { colors } from '../../theme/colors';
import { deliveryWindow, type VendorExtras } from '../promo/promo-model';

/**
 * The top of a shop's page: its banner, a white card overlapping the banner's lower edge (name,
 * rating, distance, delivery time), the active offer as a soft-red pill under the card, and the
 * search field for this shop's items.
 * The stack header is off on this screen, so the back button is drawn on the banner.
 */
export function ShopHeader({
  name,
  palika,
  extras,
  distanceKm,
  serviceable,
  freeDeliveryAboveNpr = null,
  favourite,
  onToggleFavourite,
  search,
  searchHints,
  onSearchChange,
  onBack,
}: {
  name: string;
  /** The shop's municipality, from the menu response. */
  palika: string;
  extras: VendorExtras;
  /** Null when the feed that knows it is not on the device (the page was opened directly). */
  distanceKm: number | null;
  serviceable: boolean;
  /** Step 7.2: "Free delivery on orders over Rs. X"; null when the shop offers none. */
  freeDeliveryAboveNpr?: number | null;
  /** Whether the customer has saved this shop. */
  favourite: boolean;
  onToggleFavourite: () => void;
  search: string;
  /** What the empty search field cycles through ("Search for rice..."); at least one. */
  searchHints: readonly string[];
  onSearchChange: (text: string) => void;
  onBack: () => void;
}) {
  const { t } = useTranslation();
  const { top } = useSafeAreaInsets();
  const showToast = useToastStore((state) => state.show);
  // Favourites belong to an account: a guest sees no heart.
  const signedIn = useAuthStore(selectHasSession);
  // Neighbourhood first, then the Palika: "Thamel, Kathmandu Metropolitan City".
  const location = [extras.locality, palika]
    .filter((part) => part !== null && part !== '')
    .join(', ');
  const eta =
    serviceable && distanceKm !== null ? deliveryWindow(extras.prep_minutes, distanceKm) : null;

  return (
    <View testID="shop-header">
      <View className="h-48 items-center justify-center bg-brand-light" testID="shop-banner">
        {extras.cover_image_url === null ? (
          <Ionicons name="storefront" size={56} color={colors.brand} />
        ) : (
          <Image
            source={{ uri: extras.cover_image_url }}
            className="h-full w-full"
            resizeMode="cover"
          />
        )}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('common.back')}
          testID="shop-back"
          hitSlop={8}
          style={{ top: top + 8 }}
          className="absolute left-4 h-10 w-10 items-center justify-center rounded-full bg-white shadow-sm active:bg-gray-100"
          onPress={onBack}
        >
          <Ionicons name="arrow-back" size={20} color="#111827" />
        </Pressable>
        {/* Save the shop: top right of the header, opposite Back. */}
        {signedIn ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={favourite ? t('favourites.remove') : t('favourites.add')}
            accessibilityState={{ selected: favourite }}
            testID="shop-favourite"
            hitSlop={8}
            style={{ top: top + 8 }}
            className="absolute right-4 h-10 w-10 items-center justify-center rounded-full bg-white shadow-sm active:bg-gray-100"
            onPress={onToggleFavourite}
          >
            <Ionicons
              name={favourite ? 'heart' : 'heart-outline'}
              size={20}
              color={favourite ? colors.brand : '#111827'}
            />
          </Pressable>
        ) : null}
      </View>

      <View className="-mt-12 mx-4 rounded-2xl bg-white p-4 shadow-sm" testID="shop-card">
        {/* The rating and its count are pinned to the card's top right corner; the name keeps
            clear of them. */}
        {extras.rating_average === null ? null : (
          <View className="absolute right-0 top-0 z-10 p-3">
            <RatingSummary
              rating={extras.rating_average}
              count={extras.rating_count}
              testID="shop-rating"
            />
          </View>
        )}
        <Text
          className={`text-xl font-extrabold text-gray-900 ${
            extras.rating_average === null ? '' : 'pr-28'
          }`}
          numberOfLines={2}
        >
          {name}
        </Text>

        <View className="mt-2 flex-row items-start gap-1.5">
          <Ionicons name="location-outline" size={14} color={colors.inactive} />
          <Text className="flex-1 text-sm text-gray-700" testID="shop-location">
            {location}
          </Text>
        </View>

        {distanceKm === null && eta === null ? null : (
          <View className="mt-1 flex-row items-center gap-1.5 pl-5">
            {distanceKm === null ? null : (
              <Text className="text-sm text-gray-500" testID="shop-distance">
                {t('vendor.distance', { distance: roundKm(distanceKm) })}
              </Text>
            )}
            {distanceKm === null || eta === null ? null : (
              <Text className="text-sm text-gray-400">·</Text>
            )}
            {eta === null ? null : (
              <Text className="text-sm font-semibold text-gray-700" testID="shop-eta">
                {t('vendor.deliveryTime', eta)}
              </Text>
            )}
          </View>
        )}
      </View>

      {/* The shop's active offer, as its own pill under the card. */}
      {extras.top_offer === null ? null : (
        <View
          accessible
          accessibilityLabel={t('menu.offerLabel', { offer: extras.top_offer })}
          testID="shop-offer"
          className="mx-4 mt-3 flex-row items-center gap-2 self-start rounded-full border border-red-100 bg-red-50 px-4 py-2"
        >
          <Ionicons name="pricetag" size={16} color={colors.brand} />
          <Text className="text-sm font-extrabold text-red-700" numberOfLines={1}>
            {extras.top_offer}
          </Text>
        </View>
      )}

      {freeDeliveryAboveNpr === null ? null : (
        <View
          testID="shop-free-delivery"
          className="mx-4 mt-3 flex-row items-center gap-2 self-start rounded-full border border-green-100 bg-green-50 px-4 py-2"
        >
          <Ionicons name="bicycle" size={16} color={colors.success} />
          <Text className="text-sm font-bold text-green-700" numberOfLines={1}>
            {t('menu.freeDeliveryOver', { amount: freeDeliveryAboveNpr })}
          </Text>
        </View>
      )}

      <View className="mx-4 mt-4 flex-row items-center rounded-xl bg-white px-3 shadow-sm">
        <Ionicons name="search" size={18} color={colors.inactive} />
        <View className="flex-1 justify-center">
          <RotatingPlaceholder
            phrases={searchHints}
            visible={search === ''}
            testID="menu-search-hint"
          />
          <TextInput
            testID="menu-search"
            value={search}
            onChangeText={onSearchChange}
            accessibilityLabel={t('menu.searchPlaceholder')}
            maxLength={MAX_PRODUCT_SEARCH_LENGTH}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="search"
            clearButtonMode="while-editing"
            className="px-2 py-3 text-base text-gray-900"
          />
        </View>
        {/* PLACEHOLDER: the microphone only announces that voice search is coming. */}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('discovery.voiceSearch')}
          testID="menu-voice-search"
          hitSlop={8}
          onPress={() => {
            showToast(t('discovery.voiceSearchSoon'), 'info');
          }}
        >
          <Ionicons name="mic-outline" size={22} color={colors.brand} />
        </Pressable>
      </View>
    </View>
  );
}
