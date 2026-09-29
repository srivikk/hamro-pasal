import { Stack, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, FlatList, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { Button } from '../../src/components/Button';
import { MOCK_CUSTOMER_LOCATION } from '../../src/features/feed/mock-feed-api';
import type { MenuProduct, VendorMenu } from '../../src/features/menu/menu-contract';
import { VendorNotFoundError } from '../../src/features/menu/mock-menu-api';
import { useVendorMenuQuery } from '../../src/features/menu/useVendorMenuQuery';
import {
  MAX_CART_LINES,
  MAX_LINE_QUANTITY,
  useCartStore,
  type CartVendor,
} from '../../src/store/useCartStore';
import { selectIsCheckoutPending, useCheckoutStore } from '../../src/store/useCheckoutStore';

function toCartVendor({ vendor }: VendorMenu): CartVendor {
  return {
    id: vendor.id,
    name: vendor.business_name,
    deliveryFeeNpr: vendor.base_delivery_fee_npr,
    minOrderValueNpr: vendor.min_order_value,
  };
}

export default function VendorMenuScreen() {
  const { t } = useTranslation();
  const { id } = useLocalSearchParams<{ id: string }>();
  // MOCK: the customer's real location arrives with the GPS phase.
  const menu = useVendorMenuQuery(id, MOCK_CUSTOMER_LOCATION);
  const cartVendorId = useCartStore((state) => state.vendor?.id ?? null);
  const lines = useCartStore((state) => state.lines);
  const addItem = useCartStore((state) => state.addItem);
  const checkoutPending = useCheckoutStore(selectIsCheckoutPending);
  const [notice, setNotice] = useState<string | null>(null);

  const header = (
    <Stack.Screen
      options={{
        headerShown: true,
        title: menu.data?.vendor.business_name ?? '',
        headerBackTitle: t('common.back'),
      }}
    />
  );

  if (menu.isPending) {
    return (
      <View className="flex-1 items-center justify-center bg-neutral-50">
        {header}
        <ActivityIndicator testID="menu-loading" />
      </View>
    );
  }

  if (menu.isError) {
    const notFound = menu.error instanceof VendorNotFoundError;
    return (
      <View className="flex-1 items-center justify-center gap-4 bg-neutral-50 px-6">
        {header}
        <Text className="text-center text-base text-neutral-700">
          {notFound ? t('menu.notFound') : t('menu.loadError')}
        </Text>
        {notFound ? null : <Button label={t('common.retry')} onPress={() => void menu.refetch()} />}
      </View>
    );
  }

  const { serviceable, products } = menu.data;
  const quantityInCart = (productId: string): number =>
    cartVendorId === menu.data.vendor.id
      ? (lines.find((line) => line.productId === productId)?.quantity ?? 0)
      : 0;

  const onAdd = (product: MenuProduct): void => {
    const result = addItem(toCartVendor(menu.data), {
      id: product.id,
      name: product.name,
      unitPriceNpr: product.price_npr,
    });
    // 'vendor_conflict' needs no handling here: the store raises the root ReplaceCartModal.
    if (result === 'quantity_limit') setNotice(t('menu.quantityLimit', { max: MAX_LINE_QUANTITY }));
    else if (result === 'cart_full') setNotice(t('menu.cartFull', { max: MAX_CART_LINES }));
    else setNotice(null);
  };

  const banner = !serviceable
    ? t('menu.notServiceable')
    : checkoutPending
      ? t('menu.checkoutPending')
      : notice;

  return (
    <View className="flex-1 bg-neutral-50">
      {header}
      {banner === null ? null : (
        <View className="mx-4 mt-4 rounded-xl bg-amber-50 p-3" testID="menu-banner">
          <Text className="text-sm text-amber-900">{banner}</Text>
        </View>
      )}
      <FlatList
        data={products}
        keyExtractor={(product) => product.id}
        contentContainerStyle={{ paddingTop: 16, paddingBottom: 24 }}
        ListEmptyComponent={
          <Text className="px-4 text-center text-base text-neutral-600">{t('menu.empty')}</Text>
        }
        renderItem={({ item: product }) => {
          const inCart = quantityInCart(product.id);
          return (
            <View
              testID={`menu-product-${product.id}`}
              className={`mx-4 mb-3 flex-row items-center rounded-2xl border border-neutral-200 bg-white p-4 ${
                serviceable ? '' : 'opacity-60'
              }`}
            >
              <View className="flex-1 pr-3">
                <Text className="text-base font-semibold text-neutral-900">{product.name}</Text>
                <Text className="mt-1 text-sm text-neutral-700">
                  {t('common.price', { amount: product.price_npr })}
                </Text>
                {inCart > 0 ? (
                  <Text className="mt-1 text-xs font-semibold text-brand">
                    {t('menu.inCart', { count: inCart })}
                  </Text>
                ) : null}
              </View>
              {product.in_stock ? (
                <Button
                  label={t('menu.add')}
                  size="sm"
                  accessibilityLabel={`${t('menu.add')} ${product.name}`}
                  disabled={!serviceable || checkoutPending}
                  onPress={() => {
                    onAdd(product);
                  }}
                />
              ) : (
                <Text className="text-sm font-semibold text-neutral-400">
                  {t('menu.outOfStock')}
                </Text>
              )}
            </View>
          );
        }}
      />
    </View>
  );
}
