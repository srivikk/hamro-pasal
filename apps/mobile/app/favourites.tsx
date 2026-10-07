import Ionicons from '@expo/vector-icons/Ionicons';
import { router, Stack } from 'expo-router';
import { FlatList, Pressable, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { favouriteList, useFavouritesStore } from '../src/store/useFavouritesStore';
import { colors } from '../src/theme/colors';

/**
 * "Favourites" (from the Profile tab): the shops the customer saved with the heart on a shop's
 * page, newest first. A row opens the shop; its heart removes it.
 *
 * TODO: Replace with the backend favourites (`user_favourites`, STATE_HANDOFF §8Z.8). Until then
 * the list is kept on this phone only.
 */
export default function FavouritesScreen() {
  const { t } = useTranslation();
  const favourites = useFavouritesStore((state) => state.favourites);
  const removeFavourite = useFavouritesStore((state) => state.removeFavourite);

  return (
    <View className="flex-1 bg-gray-50">
      <Stack.Screen
        options={{
          headerShown: true,
          title: t('favourites.title'),
          headerBackTitle: t('common.back'),
        }}
      />
      <FlatList
        data={favouriteList(favourites)}
        keyExtractor={(shop) => shop.vendorId}
        contentContainerStyle={{ padding: 16, gap: 12 }}
        ListEmptyComponent={
          <View className="items-center gap-3 px-6 pt-16" testID="favourites-empty">
            <Ionicons name="heart-outline" size={48} color={colors.inactive} />
            <Text className="text-center text-base text-gray-500">{t('favourites.empty')}</Text>
          </View>
        }
        renderItem={({ item: shop }) => (
          <View
            className="flex-row items-center rounded-2xl bg-white shadow-sm"
            testID={`favourite-${shop.vendorId}`}
          >
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={shop.name}
              testID={`favourite-open-${shop.vendorId}`}
              className="flex-1 flex-row items-center gap-3 p-4 active:opacity-70"
              onPress={() => {
                router.push({ pathname: '/vendor/[id]', params: { id: shop.vendorId } });
              }}
            >
              <View className="h-11 w-11 items-center justify-center rounded-xl bg-brand-light">
                <Ionicons name="storefront" size={20} color={colors.brand} />
              </View>
              <View className="flex-1">
                <Text className="text-base font-bold text-gray-900" numberOfLines={1}>
                  {shop.name}
                </Text>
                {shop.location === null || shop.location === '' ? null : (
                  <Text className="text-sm text-gray-500" numberOfLines={1}>
                    {shop.location}
                  </Text>
                )}
              </View>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('favourites.removeNamed', { name: shop.name })}
              testID={`favourite-remove-${shop.vendorId}`}
              hitSlop={8}
              className="h-12 w-12 items-center justify-center active:opacity-60"
              onPress={() => {
                removeFavourite(shop.vendorId);
              }}
            >
              <Ionicons name="heart" size={22} color={colors.brand} />
            </Pressable>
          </View>
        )}
      />
    </View>
  );
}
