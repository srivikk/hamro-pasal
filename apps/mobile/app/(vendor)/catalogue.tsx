import type { VendorProductView } from '@hamro-pasal/shared-types';
import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { memo, useCallback, useMemo } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Platform,
  Pressable,
  RefreshControl,
  Switch,
  Text,
  View,
  type ListRenderItem,
} from 'react-native';
import { useTranslation } from 'react-i18next';

import { Button } from '../../src/components/Button';
import { useCategoriesQuery } from '../../src/features/discovery/useCategoriesQuery';
import {
  categoryNameOf,
  productCategoryOptions,
  productStatusOf,
  type ProductCategoryOption,
} from '../../src/features/vendor/product-form';
import {
  loadedProducts,
  useOwnProductsQuery,
  useSetProductInStock,
} from '../../src/features/vendor/useVendorProducts';
import { useToastStore } from '../../src/store/useToastStore';
import { colors } from '../../src/theme/colors';

interface ProductRowProps {
  product: VendorProductView;
  /** The offered categories, or null while the taxonomy is loading. */
  categories: readonly ProductCategoryOption[] | null;
  /** The row's switch is waiting for the server. */
  switching: boolean;
  onToggle: (product: VendorProductView, inStock: boolean) => void;
  onEdit: (id: string) => void;
}

/** One product: what it is, what it costs, how many are left, and whether it is in stock. */
const ProductRow = memo(function ProductRow({
  product,
  categories,
  switching,
  onToggle,
  onEdit,
}: ProductRowProps) {
  const { t } = useTranslation();
  const status = productStatusOf(product);
  return (
    <View
      className="flex-row items-center gap-3 rounded-2xl bg-white p-3 shadow-sm"
      testID={`product-${product.id}`}
    >
      <Pressable
        testID={`product-edit-${product.id}`}
        accessibilityRole="button"
        accessibilityLabel={t('vendorCatalogue.edit', { name: product.name })}
        className="flex-1 flex-row items-center gap-3"
        onPress={() => {
          onEdit(product.id);
        }}
      >
        <View className="h-14 w-14 items-center justify-center rounded-xl bg-gray-100">
          <Ionicons name="basket-outline" size={26} color={colors.inactive} />
        </View>
        <View className="flex-1 gap-0.5">
          <Text className="text-base font-semibold text-gray-900" numberOfLines={2}>
            {product.name}
          </Text>
          <Text className="text-sm text-gray-500" numberOfLines={1}>
            {categories === null
              ? null
              : product.category_id === null
                ? t('vendorCatalogue.noCategory')
                : (categoryNameOf(categories, product.category_id) ??
                  t('vendorCatalogue.categoryHidden'))}
          </Text>
          <Text className="text-sm font-semibold text-gray-800">
            {t('common.price', { amount: product.price_npr })}
          </Text>
        </View>
      </Pressable>
      <View className="items-end gap-1">
        <Switch
          testID={`product-stock-switch-${product.id}`}
          accessibilityLabel={t('vendorCatalogue.stockSwitch', { name: product.name })}
          value={product.in_stock}
          // A product the Super Admin hid cannot be ordered either way; the switch waits.
          disabled={switching || !product.is_active}
          onValueChange={(value) => {
            onToggle(product, value);
          }}
          // Switch takes raw colours, not a className.
          trackColor={{ true: colors.success, false: colors.inactive }}
        />
        <Text
          testID={`product-stock-${product.id}`}
          className={`text-xs font-semibold ${status === 'ORDERABLE' ? 'text-emerald-700' : 'text-red-700'}`}
        >
          {status === 'HIDDEN_BY_ADMIN'
            ? t('vendorCatalogue.hidden')
            : status === 'SWITCHED_OFF'
              ? t('vendorCatalogue.outOfStock')
              : status === 'ORDERABLE'
                ? t('vendorCatalogue.inStock', { count: product.stock_quantity })
                : t('vendorCatalogue.noStockLeft')}
        </Text>
      </View>
    </View>
  );
});

const keyOf = (product: VendorProductView): string => product.id;

/**
 * Vendor flow step 3: the shop's products as the server holds them (GET /api/vendor/products,
 * hidden ones included), each with an In Stock / Out of Stock switch, and a button to add one.
 * Tapping a product opens it for editing.
 *
 * Decided 2026-10-21: the switch is the product's `in_stock` alone (PATCH …/availability). It
 * never changes the count, and never hides the product: whether customers see it (`is_active`)
 * is the Super Admin's moderation, shown here and not editable.
 */
export default function VendorCatalogueScreen() {
  const { t } = useTranslation();
  const query = useOwnProductsQuery();
  const products = useMemo(() => loadedProducts(query.data), [query.data]);
  const stock = useSetProductInStock();
  const toast = useToastStore((store) => store.show);
  const taxonomy = useCategoriesQuery().data;
  const categories = useMemo(
    () => (taxonomy === undefined ? null : productCategoryOptions(taxonomy.categories)),
    [taxonomy],
  );

  const onEdit = useCallback((id: string) => {
    router.push({ pathname: '/product', params: { id } });
  }, []);
  const setInStock = stock.mutate;
  const onToggle = useCallback(
    (product: VendorProductView, value: boolean) => {
      setInStock(
        { product, inStock: value },
        {
          onError: () => {
            toast(t('vendorCatalogue.toggleError'), 'error');
          },
        },
      );
    },
    [setInStock, t, toast],
  );
  const switchingId = stock.isPending ? stock.variables.product.id : null;
  const renderItem = useCallback<ListRenderItem<VendorProductView>>(
    ({ item }) => (
      <ProductRow
        product={item}
        categories={categories}
        switching={switchingId === item.id}
        onToggle={onToggle}
        onEdit={onEdit}
      />
    ),
    [categories, onEdit, onToggle, switchingId],
  );

  if (query.data === undefined) {
    return (
      <View
        className="flex-1 items-center justify-center gap-4 bg-gray-50 px-6"
        testID="vendor-catalogue"
      >
        {query.isError ? (
          <>
            <Text className="text-center text-base text-gray-700" testID="catalogue-load-error">
              {t('vendorCatalogue.loadError')}
            </Text>
            <Button label={t('common.retry')} onPress={() => void query.refetch()} />
          </>
        ) : (
          <ActivityIndicator testID="catalogue-loading" />
        )}
      </View>
    );
  }

  return (
    <View className="flex-1 bg-gray-50" testID="vendor-catalogue">
      <FlatList
        testID="catalogue-list"
        className="flex-1"
        // Room under the last row for the Add button.
        contentContainerStyle={{ padding: 16, gap: 12, paddingBottom: 96 }}
        data={products}
        keyExtractor={keyOf}
        renderItem={renderItem}
        initialNumToRender={8}
        maxToRenderPerBatch={8}
        windowSize={7}
        removeClippedSubviews={Platform.OS === 'android'}
        onEndReached={() => {
          if (query.hasNextPage && !query.isFetchingNextPage && !query.isFetchNextPageError) {
            void query.fetchNextPage();
          }
        }}
        ListEmptyComponent={
          <Text className="text-center text-base text-gray-500" testID="catalogue-empty">
            {t('vendorCatalogue.empty')}
          </Text>
        }
        ListFooterComponent={
          query.isFetchNextPageError ? (
            <Button
              label={t('common.retry')}
              variant="secondary"
              onPress={() => void query.fetchNextPage()}
            />
          ) : query.isFetchingNextPage ? (
            <ActivityIndicator />
          ) : null
        }
        refreshControl={
          <RefreshControl
            refreshing={query.isRefetching && !query.isFetchingNextPage}
            onRefresh={() => void query.refetch()}
          />
        }
      />
      <Pressable
        testID="catalogue-add"
        accessibilityRole="button"
        accessibilityLabel={t('vendorCatalogue.add')}
        className="absolute bottom-6 right-4 h-14 flex-row items-center gap-2 rounded-full bg-brand px-5 shadow-sm active:bg-brand-dark"
        onPress={() => {
          router.push('/product');
        }}
      >
        <Ionicons name="add" size={24} color="#FFFFFF" />
        <Text className="text-base font-semibold text-white">{t('vendorCatalogue.add')}</Text>
      </Pressable>
    </View>
  );
}
