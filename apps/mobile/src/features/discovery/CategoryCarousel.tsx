import Ionicons from '@expo/vector-icons/Ionicons';
import type { CategoryView } from '@hamro-pasal/shared-types';
import type { ComponentProps } from 'react';
import { Image, Pressable, ScrollView, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { colors } from '../../theme/colors';

type IconName = ComponentProps<typeof Ionicons>['name'];

/** A fitting icon for a category without artwork, guessed from its slug. */
export function categoryIcon(slug: string): IconName {
  const rules: readonly (readonly [RegExp, IconName])[] = [
    [/grocer|kirana|food|rice|snack/, 'basket'],
    [/cloth|fashion|wear|apparel/, 'shirt'],
    [/electr|mobile|phone|gadget/, 'phone-portrait'],
    [/pharm|medic|health/, 'medkit'],
    [/veg|fruit|fresh/, 'leaf'],
    [/dairy|milk|tea|coffee|drink|beverage/, 'cafe'],
    [/book|station/, 'book'],
    [/home|furnitur|kitchen/, 'home'],
    [/beauty|cosmet|care/, 'sparkles'],
  ];
  return rules.find(([pattern]) => pattern.test(slug))?.[1] ?? 'pricetag';
}

function Item({
  label,
  selected,
  testID,
  onPress,
  children,
}: {
  label: string;
  selected: boolean;
  testID: string;
  onPress: () => void;
  children: React.ReactNode;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected }}
      testID={testID}
      className="w-20 items-center gap-1.5 active:opacity-70"
      onPress={onPress}
    >
      <View
        // The shadow is on in BOTH states on purpose. NativeWind implements shadow-* with CSS
        // variables, and a view that gains them after its first render is "upgraded" at runtime;
        // in development that path logs the view's props and crashes on them with "Couldn't find
        // a navigation context". Only the border and the fill change with the selection.
        className={`h-16 w-16 items-center justify-center overflow-hidden rounded-full border-2 shadow-sm ${
          selected ? 'border-brand bg-brand-light' : 'border-transparent bg-white'
        }`}
      >
        {children}
      </View>
      <Text
        className={`text-center text-xs ${selected ? 'font-bold text-brand' : 'font-medium text-gray-700'}`}
        numberOfLines={2}
      >
        {label}
      </Text>
    </Pressable>
  );
}

/**
 * "What's on your mind?": the root categories as a horizontal row of round tiles above the shop
 * feed. Tapping one filters the feed to the shops that carry it; "All Shops" (or tapping the
 * chosen one again) clears the filter.
 */
export function CategoryCarousel({
  categories,
  selectedId,
  onSelect,
}: {
  categories: readonly CategoryView[];
  selectedId: string | null;
  onSelect: (categoryId: string | null) => void;
}) {
  const { t } = useTranslation();
  return (
    <View className="pb-2 pt-3" testID="category-carousel">
      <Text className="px-4 pb-3 text-lg font-bold text-gray-900">{t('categories.title')}</Text>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ paddingHorizontal: 12, gap: 4 }}
      >
        <Item
          label={t('categories.all')}
          selected={selectedId === null}
          testID="category-all"
          onPress={() => {
            onSelect(null);
          }}
        >
          <Ionicons name="storefront" size={26} color={colors.brand} />
        </Item>
        {categories.map((category) => (
          <Item
            key={category.id}
            label={category.name}
            selected={category.id === selectedId}
            testID={`category-${category.id}`}
            onPress={() => {
              onSelect(category.id === selectedId ? null : category.id);
            }}
          >
            {category.icon_url === null ? (
              <Ionicons name={categoryIcon(category.slug)} size={26} color={colors.brand} />
            ) : (
              <Image source={{ uri: category.icon_url }} className="h-16 w-16" resizeMode="cover" />
            )}
          </Item>
        ))}
      </ScrollView>
    </View>
  );
}
