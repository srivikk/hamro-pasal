import Ionicons from '@expo/vector-icons/Ionicons';
import { MAX_PRODUCT_SEARCH_LENGTH } from '@hamro-pasal/shared-types';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { Button } from '../../../src/components/Button';
import { RotatingPlaceholder } from '../../../src/components/RotatingPlaceholder';
import { FeedSkeleton } from '../../../src/components/Skeleton';
import { CategoryCarousel } from '../../../src/features/discovery/CategoryCarousel';
import {
  filterFeedByVendors,
  useCategoryVendorIds,
} from '../../../src/features/discovery/category-shops';
import {
  findCategoryByTarget,
  rootCategories,
} from '../../../src/features/discovery/discovery-rules';
import { ProductResults } from '../../../src/features/discovery/ProductResults';
import { useCategoriesQuery } from '../../../src/features/discovery/useCategoriesQuery';
import { useProductSearch } from '../../../src/features/discovery/useProductSearch';
import {
  DEFAULT_FEED_SORT,
  vendorIdsWithOfferTag,
  type FeedSort,
} from '../../../src/features/feed/feed-sort';
import { categoryEmptyState } from '../../../src/features/feed/empty-states';
import { ShopsFeed } from '../../../src/features/feed/ShopsFeed';
import { FeedFilterBar, SortFilterSheet } from '../../../src/features/feed/SortFilterSheet';
import { useFeedQuery } from '../../../src/features/feed/useFeedQuery';
import {
  useCustomerLocation,
  useHasBrowseLocation,
} from '../../../src/features/location/customer-location';
import { HeaderGradient } from '../../../src/features/location/HeaderGradient';
import { LocationHeader } from '../../../src/features/location/LocationHeader';
import { BannerCarousel } from '../../../src/features/promo/BannerCarousel';
import { FeaturedOffers } from '../../../src/features/promo/FeaturedOffers';
import { vendorExtras } from '../../../src/features/promo/mock-promotions';
import { useHomePromotions } from '../../../src/features/promo/useHomePromotions';
import type { PromoTarget } from '../../../src/features/promo/promo-model';
import { useBrowseLocationStore } from '../../../src/store/useBrowseLocationStore';
import { useToastStore } from '../../../src/store/useToastStore';
import { colors } from '../../../src/theme/colors';

/**
 * Home: the location and search hub on top, then the vendor feed. Typing in the search field
 * swaps the feed for the results (matching shops, then matching products); clearing it brings
 * the feed back.
 */
export default function FeedScreen() {
  const { t } = useTranslation();
  const hasLocation = useHasBrowseLocation();
  // The place chosen in the header, else the device position, else the delivery address. With
  // none of them the feed is not asked for: the customer is prompted to select a location.
  const feed = useFeedQuery(useCustomerLocation(), hasLocation);
  const showToast = useToastStore((state) => state.show);
  const [searchInput, setSearchInput] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);
  // Location refused at boot and nothing selected: show "Select delivery location" once, by
  // itself. Not before the boot check has answered (the position may simply not be known yet).
  const deviceChecked = useBrowseLocationStore((state) => state.deviceChecked);
  const offered = useRef(false);
  useEffect(() => {
    if (deviceChecked && !hasLocation && !offered.current) {
      offered.current = true;
      setPickerOpen(true);
    }
  }, [deviceChecked, hasLocation]);

  // One search for the marketplace: shops by name (from the feed, on the device) and products
  // by name (the public product list). There is no category toggle: every product belongs to a shop.
  const search = useProductSearch(searchInput, null);

  // "What's on your mind?": the root categories of the taxonomy. Choosing one keeps only the
  // shops that sell something in it (or in its subcategories).
  const categories = useCategoriesQuery();
  const [chosenCategoryId, setChosenCategoryId] = useState<string | null>(null);
  const allCategories = categories.data?.categories ?? [];
  const roots = rootCategories(allCategories);
  // A category that left the taxonomy (hidden by an admin) stops filtering as soon as it is gone.
  // Looked up in the whole taxonomy: a promotion may point at a subcategory, which has no tile.
  const chosenCategory = allCategories.find((category) => category.id === chosenCategoryId);
  const categoryId = chosenCategory?.id ?? null;
  const categoryShops = useCategoryVendorIds(categoryId);

  // The categories stay current without a restart: refetched when Home comes back into view (from
  // a shop, another tab), besides the app's return to the foreground and the pull to refresh.
  const refetchCategories = categories.refetch;
  const firstFocus = useRef(true);
  useFocusEffect(
    useCallback(() => {
      if (firstFocus.current) {
        firstFocus.current = false;
        return;
      }
      void refetchCategories();
    }, [refetchCategories]),
  );
  const refreshHome = (): void => {
    void feed.refetch();
    void categories.refetch();
    if (categoryId !== null) void categoryShops.refetch();
  };

  // An offer label chosen by tapping a DISCOUNT_TAG promotion: only the shops that carry it.
  // Purely a filter: no price in the app depends on it (STATE_HANDOFF §8Z.4).
  const [discountTag, setDiscountTag] = useState<string | null>(null);
  const tagShops =
    discountTag === null || feed.data === undefined
      ? null
      : vendorIdsWithOfferTag(feed.data, discountTag, vendorExtras);

  // The shops left by the category and the offer label together. Null: no filter (or not known yet).
  const categoryIds = categoryId === null ? null : (categoryShops.data ?? null);
  const onlyVendorIds =
    categoryIds === null || tagShops === null
      ? (categoryIds ?? tagShops)
      : categoryIds.filter((vendorId) => tagShops.includes(vendorId));
  const filteredFeed =
    feed.data === undefined || onlyVendorIds === null
      ? null
      : filterFeedByVendors(feed.data, onlyVendorIds);
  const noShopLeft =
    filteredFeed !== null &&
    filteredFeed.serviceable.length + filteredFeed.explore_further.length === 0;

  // The order of the shops inside each section, chosen in the "Sort & filter" sheet.
  const [sort, setSort] = useState<FeedSort>(DEFAULT_FEED_SORT);
  const [sortOpen, setSortOpen] = useState(false);

  // Set by a promotion that filters the feed: the list then scrolls down to its first shop.
  const [scrollToShops, setScrollToShops] = useState(false);
  const onScrolledToShops = useCallback(() => {
    setScrollToShops(false);
  }, []);

  // The admin's banners and offers (GET /api/home/promotions, STATE_HANDOFF §8Z.29). With none,
  // both rows render nothing and the categories sit directly under the header as before.
  const promotions = useHomePromotions(feed.data);
  const openPromotion = (target: PromoTarget): void => {
    if (target.type === 'SHOP') {
      router.push({ pathname: '/vendor/[id]', params: { id: target.value } });
      return;
    }
    if (target.type === 'CATEGORY') {
      // The same selection a category tile makes; a promotion replaces any offer filter.
      const category = findCategoryByTarget(allCategories, target.value);
      if (category === undefined) {
        showToast(t('promo.unavailable'), 'info');
        return;
      }
      setChosenCategoryId(category.id);
      setDiscountTag(null);
    } else {
      setDiscountTag(target.value);
      setChosenCategoryId(null);
    }
    setScrollToShops(true);
  };
  const clearFilters = (): void => {
    setChosenCategoryId(null);
    setDiscountTag(null);
    setScrollToShops(false);
  };

  // Everything between the header and the shops. It scrolls away with the list.
  const discovery = (
    <>
      <BannerCarousel banners={promotions.banners} onOpen={openPromotion} />
      <FeaturedOffers offers={promotions.offers} onOpen={openPromotion} />
      {roots.length === 0 ? null : (
        <CategoryCarousel
          categories={roots}
          selectedId={categoryId}
          onSelect={setChosenCategoryId}
        />
      )}
      <FeedFilterBar
        sort={sort}
        onOpen={() => {
          setSortOpen(true);
        }}
        onClear={() => {
          setSort(DEFAULT_FEED_SORT);
        }}
        discountTag={discountTag}
        onClearTag={() => {
          setDiscountTag(null);
        }}
      />
    </>
  );

  return (
    <View className="flex-1 bg-gray-50">
      <HeaderGradient>
        <LocationHeader open={pickerOpen} onOpenChange={setPickerOpen} />
        <View className="px-4 pb-4 pt-1">
          <View className="flex-row items-center rounded-xl bg-white px-3 shadow-sm">
            <Ionicons name="search" size={18} color={colors.inactive} />
            <View className="flex-1 justify-center">
              {/* What can be searched for, one suggestion at a time, while the field is empty. */}
              <RotatingPlaceholder
                phrases={[
                  t('discovery.searchHints.groceries'),
                  t('discovery.searchHints.snacks'),
                  t('discovery.searchHints.shop'),
                ]}
                visible={searchInput === ''}
                testID="product-search-hint"
              />
              <TextInput
                testID="product-search"
                value={searchInput}
                onChangeText={setSearchInput}
                accessibilityLabel={t('discovery.searchPlaceholder')}
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
              testID="voice-search"
              hitSlop={8}
              onPress={() => {
                showToast(t('discovery.voiceSearchSoon'), 'info');
              }}
            >
              <Ionicons name="mic-outline" size={22} color={colors.brand} />
            </Pressable>
          </View>
        </View>
      </HeaderGradient>
      {search.active ? (
        <ProductResults
          search={search}
          searchText={searchInput}
          feed={feed.data}
          needsLocation={!hasLocation}
        />
      ) : hasLocation ? (
        <>
          {categoryId !== null && categoryShops.isPending ? (
            <ScrollView contentContainerStyle={{ flexGrow: 1 }}>
              {discovery}
              <FeedSkeleton testID="category-shops-loading" />
            </ScrollView>
          ) : categoryId !== null && categoryShops.isError ? (
            <ScrollView contentContainerStyle={{ flexGrow: 1 }}>
              {discovery}
              <View className="flex-1 items-center justify-center gap-4 px-6 py-8">
                <Text className="text-center text-base text-gray-700">{t('feed.loadError')}</Text>
                <Button label={t('common.retry')} onPress={() => void categoryShops.refetch()} />
              </View>
            </ScrollView>
          ) : noShopLeft ? (
            <ScrollView contentContainerStyle={{ flexGrow: 1 }}>
              {discovery}
              <View
                className="flex-1 items-center justify-center gap-4 px-6 py-8"
                testID={discountTag === null ? 'category-empty' : 'tag-empty'}
              >
                <Text className="text-center text-base text-gray-700">
                  {discountTag !== null
                    ? t('promo.tagEmpty', { tag: discountTag })
                    : // No shop anywhere sells it yet: an inventory shortage, said welcomingly.
                      categoryEmptyState(categoryShops.data ?? []) === 'ONBOARDING'
                      ? t('categories.onboarding', { category: chosenCategory?.name ?? '' })
                      : t('categories.empty', { category: chosenCategory?.name ?? '' })}
                </Text>
                <Button label={t('categories.all')} variant="secondary" onPress={clearFilters} />
              </View>
            </ScrollView>
          ) : (
            <ShopsFeed
              feed={feed}
              onlyVendorIds={onlyVendorIds}
              sort={sort}
              header={discovery}
              scrollToShops={scrollToShops}
              onScrolledToShops={onScrolledToShops}
              onRefresh={refreshHome}
            />
          )}
          <SortFilterSheet
            visible={sortOpen}
            sort={sort}
            onApply={(chosen) => {
              setSort(chosen);
              setSortOpen(false);
            }}
            onClose={() => {
              setSortOpen(false);
            }}
          />
        </>
      ) : (
        <View
          className="flex-1 items-center justify-center gap-4 px-6"
          testID="select-location-prompt"
        >
          <Ionicons name="location-outline" size={48} color={colors.inactive} />
          <Text className="text-center text-base text-gray-700">
            {t('browseLocation.selectPrompt')}
          </Text>
          <Button
            label={t('browseLocation.select')}
            onPress={() => {
              setPickerOpen(true);
            }}
          />
        </View>
      )}
    </View>
  );
}
