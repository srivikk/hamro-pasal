import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { memo, useCallback, useMemo } from 'react';
import {
  FlatList,
  Platform,
  Pressable,
  Switch,
  Text,
  View,
  type ListRenderItem,
} from 'react-native';
import { useTranslation } from 'react-i18next';

import { useCategoriesQuery } from '../../src/features/discovery/useCategoriesQuery';
import {
  categoryNameOf,
  productCategoryOptions,
  type ProductCategoryOption,
} from '../../src/features/vendor/product-form';
import { VendorSectionPlaceholder } from '../../src/features/vendor/VendorSectionPlaceholder';
import {
  useVendorCatalogueStore,
  VENDOR_CATALOGUE_MOCKS_ENABLED,
  type CatalogueProduct,
} from '../../src/store/useVendorCatalogueStore';
import { colors } from '../../src/theme/colors';

interface ProductRowProps {
  product: CatalogueProduct;
  /** The offered categories, or null while the taxonomy is loading. */
  categories: readonly ProductCategoryOption[] | null;
  onToggle: (id: string, isAvailable: boolean) => void;
  onEdit: (id: string) => void;
}

/** One product: what it is, what it costs, how many are left, and the In Stock switch. */
const ProductRow = memo(function ProductRow({
  product,
  categories,
  onToggle,
  onEdit,
}: ProductRowProps) {
  const { t } = useTranslation();
  // On sale only when the vendor has it switched on and there is stock to sell.
  const inStock = product.isAvailable && product.stockQuantity > 0;
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
              : (categoryNameOf(categories, product.categoryId) ??
                t('vendorCatalogue.categoryHidden'))}
          </Text>
          <Text className="text-sm font-semibold text-gray-800">
            {t('common.price', { amount: product.priceNpr })}
          </Text>
        </View>
      </Pressable>
      <View className="items-end gap-1">
        <Switch
          testID={`product-stock-switch-${product.id}`}
          accessibilityLabel={t('vendorCatalogue.stockSwitch', { name: product.name })}
          value={product.isAvailable}
          onValueChange={(value) => {
            onToggle(product.id, value);
          }}
          // Switch takes raw colours, not a className.
          trackColor={{ true: colors.success, false: colors.inactive }}
        />
        <Text
          testID={`product-stock-${product.id}`}
          className={`text-xs font-semibold ${inStock ? 'text-emerald-700' : 'text-red-700'}`}
        >
          {inStock
            ? t('vendorCatalogue.inStock', { count: product.stockQuantity })
            : product.isAvailable
              ? t('vendorCatalogue.noStockLeft')
              : t('vendorCatalogue.outOfStock')}
        </Text>
      </View>
    </View>
  );
});

const keyOf = (product: CatalogueProduct): string => product.id;

/**
 * Vendor flow step 3: the shop's products, each with a switch that takes it out of stock (or puts
 * it back) at once, and a button to add one. Tapping a product opens it for editing.
 *
 * TODO: wire to the API: `GET /api/vendor/products` for the list (it exists) and
 * `PATCH /api/vendor/products/:id/availability` for the switch (to build, STATE_HANDOFF.md §8Z.14). Until then the catalogue is sample data
 * held on the device (development builds), and a production build shows the placeholder.
 */
export default function VendorCatalogueScreen() {
  const { t } = useTranslation();
  const products = useVendorCatalogueStore((state) => state.products);
  const setAvailable = useVendorCatalogueStore((state) => state.setAvailable);
  const taxonomy = useCategoriesQuery().data;
  const categories = useMemo(
    () => (taxonomy === undefined ? null : productCategoryOptions(taxonomy.categories)),
    [taxonomy],
  );

  const onEdit = useCallback((id: string) => {
    router.push({ pathname: '/product', params: { id } });
  }, []);
  const renderItem = useCallback<ListRenderItem<CatalogueProduct>>(
    ({ item }) => (
      <ProductRow product={item} categories={categories} onToggle={setAvailable} onEdit={onEdit} />
    ),
    [categories, onEdit, setAvailable],
  );

  if (!VENDOR_CATALOGUE_MOCKS_ENABLED) {
    return (
      <VendorSectionPlaceholder
        testID="vendor-catalogue"
        icon="pricetags-outline"
        title={t('vendorTabs.catalogue.title')}
        body={t('vendorTabs.catalogue.body')}
        items={[
          t('vendorTabs.catalogue.products'),
          t('vendorTabs.catalogue.stock'),
          t('vendorTabs.catalogue.photos'),
        ]}
      />
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
        ListHeaderComponent={
          <Text className="text-sm text-gray-500" testID="catalogue-sample-note">
            {t('vendorCatalogue.sampleNote')}
          </Text>
        }
        ListEmptyComponent={
          <Text className="text-center text-base text-gray-500" testID="catalogue-empty">
            {t('vendorCatalogue.empty')}
          </Text>
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
