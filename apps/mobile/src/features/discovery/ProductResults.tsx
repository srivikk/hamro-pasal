import type { FeedResponse } from '@hamro-pasal/shared-types';
import { useQueryClient } from '@tanstack/react-query';
import { ActivityIndicator, FlatList, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { Button } from '../../components/Button';
import { selectHasSession, useAuthStore } from '../../store/useAuthStore';
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

/** The product list for the current search and category, with paging and the add-to-cart picker. */
export function ProductResults({
  search,
  feed,
}: {
  search: ProductSearch;
  /** The vendor feed, once loaded. Until then nothing can be added (delivery is unknown). */
  feed: FeedResponse | undefined;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const signedIn = useAuthStore(selectHasSession);
  const frozen = useCheckoutStore(selectIsCheckoutPending);
  const { query } = search;

  if (search.isDebouncing || query.isPending) {
    return (
      <View className="flex-1 items-center justify-center bg-neutral-50">
        <ActivityIndicator testID="products-loading" />
      </View>
    );
  }

  if (query.isError && !query.isFetchNextPageError) {
    return (
      <View className="flex-1 items-center justify-center gap-4 bg-neutral-50 px-6">
        <Text className="text-center text-base text-neutral-700">{t('discovery.loadError')}</Text>
        <Button label={t('common.retry')} onPress={() => void query.refetch()} />
      </View>
    );
  }

  const vendors = feed === undefined ? null : serviceableVendors(feed);
  // SPEC customer flow step 3: a shop that does not deliver here is browse-only.
  const blockedReason =
    vendors !== null ? t('vendor.unavailable') : signedIn ? null : t('discovery.signInToOrder');

  return (
    <FlatList
      testID="product-list"
      className="flex-1 bg-neutral-50"
      data={query.data.pages.flatMap((page) => page.products)}
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
        <Text className="px-4 pt-8 text-center text-base text-neutral-600" testID="products-empty">
          {t('discovery.empty')}
        </Text>
      }
      ListFooterComponent={
        query.isFetchingNextPage ? (
          <ActivityIndicator testID="products-loading-more" />
        ) : query.isFetchNextPageError ? (
          <View className="items-center gap-2 px-4">
            <Text className="text-sm text-neutral-700">{t('discovery.loadMoreError')}</Text>
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
