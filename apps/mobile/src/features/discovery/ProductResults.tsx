import type { FeedEntry, FeedResponse } from '@hamro-pasal/shared-types';
import { useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { ActivityIndicator, FlatList, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { Button } from '../../components/Button';
import { RowsSkeleton } from '../../components/Skeleton';
import { VendorCard } from '../../components/VendorCard';
import type { CartVendor } from '../../store/useCartStore';
import { selectIsCheckoutPending, useCheckoutStore } from '../../store/useCheckoutStore';
import { ProductCard } from './ProductCard';
import { CATEGORIES_QUERY_KEY } from './useCategoriesQuery';
import type { ProductSearch } from './useProductSearch';

/**
 * The shops that deliver to the customer, as cart vendors. The public product list names only the
 * shop; whether it delivers here (SPEC §2) and its fee and minimum order come from the feed.
 */
export function serviceableVendors(feed: FeedResponse): Map<string, CartVendor> {
  return new Map(
    feed.serviceable.map(({ vendor }) => [
      vendor.id,
      {
        id: vendor.id,
        name: vendor.business_name,
        deliveryFeeNpr: vendor.base_delivery_fee_npr,
        minOrderValueNpr: vendor.min_order_value,
      },
    ]),
  );
}

/**
 * The shops of the feed whose name contains every word typed (case-insensitive), serviceable
 * ones first, as the feed orders them. The feed is already on the device, so this is local.
 */
export function matchingVendors(feed: FeedResponse | undefined, text: string): FeedEntry[] {
  const words = text
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word !== '');
  if (feed === undefined || words.length === 0) return [];
  return [...feed.serviceable, ...feed.explore_further].filter(({ vendor }) => {
    const name = vendor.business_name.toLowerCase();
    return words.every((word) => name.includes(word));
  });
}

/**
 * Search results: the shops whose name matches, then the products whose name matches (paged,
 * with the add-to-cart picker).
 */
export function ProductResults({
  search,
  searchText = '',
  feed,
  needsLocation = false,
}: {
  search: ProductSearch;
  /** What is typed in the search field: matched against shop names on the device. */
  searchText?: string;
  /** The vendor feed, once loaded. Until then nothing can be added (delivery is unknown). */
  feed: FeedResponse | undefined;
  /** No browsing location is known: products are browse-only until one is selected. */
  needsLocation?: boolean;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const frozen = useCheckoutStore(selectIsCheckoutPending);
  const { query } = search;

  if (search.isDebouncing || query.isPending) {
    return (
      <View className="flex-1 bg-gray-50">
        <RowsSkeleton testID="products-loading" />
      </View>
    );
  }

  if (query.isError && !query.isFetchNextPageError) {
    return (
      <View className="flex-1 items-center justify-center gap-4 bg-gray-50 px-6">
        <Text className="text-center text-base text-gray-700">{t('discovery.loadError')}</Text>
        <Button label={t('common.retry')} onPress={() => void query.refetch()} />
      </View>
    );
  }

  const vendors = feed === undefined ? null : serviceableVendors(feed);
  const shops = matchingVendors(feed, searchText);
  const products = query.data.pages.flatMap((page) => page.products);
  // SPEC customer flow step 3: a shop that does not deliver here is browse-only. Guests order
  // like anyone else (the feed is public); until the feed has loaded there is no reason to give.
  const blockedReason =
    vendors !== null
      ? t('vendor.unavailable')
      : needsLocation
        ? t('browseLocation.selectToOrder')
        : null;

  return (
    <FlatList
      testID="product-list"
      className="flex-1 bg-gray-50"
      data={products}
      ListHeaderComponent={
        shops.length === 0 ? null : (
          <View testID="shop-results">
            <Text className="px-4 pb-2 pt-2 text-xs font-bold uppercase tracking-wide text-gray-500">
              {t('discovery.shopsHeading')}
            </Text>
            {shops.map((entry) => (
              <VendorCard
                key={entry.vendor.id}
                entry={entry}
                onPress={(vendorId) => {
                  router.push({ pathname: '/vendor/[id]', params: { id: vendorId } });
                }}
              />
            ))}
            {products.length === 0 ? null : (
              <Text className="px-4 pb-2 pt-4 text-xs font-bold uppercase tracking-wide text-gray-500">
                {t('discovery.productsHeading')}
              </Text>
            )}
          </View>
        )
      }
      keyExtractor={(product) => product.id}
      contentContainerStyle={{ paddingTop: 4, paddingBottom: 24 }}
      refreshing={query.isRefetching}
      onRefresh={() => {
        void queryClient.invalidateQueries({ queryKey: CATEGORIES_QUERY_KEY });
        void query.refetch();
      }}
      onEndReachedThreshold={0.5}
      onEndReached={() => {
        // A failed page is retried by its button, not by scrolling.
        if (query.hasNextPage && !query.isFetchingNextPage && !query.isFetchNextPageError) {
          void query.fetchNextPage();
        }
      }}
      ListEmptyComponent={
        // A shop matched: "no products" would be wrong.
        shops.length > 0 ? null : (
          <Text className="px-4 pt-8 text-center text-base text-gray-500" testID="products-empty">
            {t('discovery.empty')}
          </Text>
        )
      }
      ListFooterComponent={
        query.isFetchingNextPage ? (
          <ActivityIndicator testID="products-loading-more" />
        ) : query.isFetchNextPageError ? (
          <View className="items-center gap-2 px-4">
            <Text className="text-sm text-gray-700">{t('discovery.loadMoreError')}</Text>
            <Button
              label={t('common.retry')}
              size="sm"
              variant="secondary"
              onPress={() => void query.fetchNextPage()}
            />
          </View>
        ) : null
      }
      renderItem={({ item: product }) => (
        <ProductCard
          product={product}
          cartVendor={vendors?.get(product.vendor.id) ?? null}
          blockedReason={blockedReason}
          frozen={frozen}
        />
      )}
    />
  );
}
