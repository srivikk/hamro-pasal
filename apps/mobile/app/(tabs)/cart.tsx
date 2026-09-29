import { FlatList, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { Button } from '../../src/components/Button';
import { formatLocalizedNumber } from '../../src/i18n/format-number';
import { toNpr, toPaisa } from '../../src/lib/money';
import { useAuthStore } from '../../src/store/useAuthStore';
import {
  MAX_LINE_QUANTITY,
  useCartStore,
  useCartTotal,
  useItemCount,
} from '../../src/store/useCartStore';

export default function CartScreen() {
  const { t } = useTranslation();
  const locale = useAuthStore((state) => state.locale);
  const vendor = useCartStore((state) => state.vendor);
  const lines = useCartStore((state) => state.lines);
  const setQuantity = useCartStore((state) => state.setQuantity);
  const clearCart = useCartStore((state) => state.clearCart);
  const cartTotal = useCartTotal();
  const itemCount = useItemCount();

  if (vendor === null) {
    return (
      <View className="flex-1 items-center justify-center bg-neutral-50 px-6">
        <Text className="text-base text-neutral-600">{t('cart.empty')}</Text>
      </View>
    );
  }

  return (
    <View className="flex-1 bg-neutral-50">
      <FlatList
        data={lines}
        keyExtractor={(line) => line.productId}
        ListHeaderComponent={
          <Text className="px-4 pb-2 pt-4 text-lg font-bold text-neutral-900">
            {t('cart.from', { vendor: vendor.name })}
          </Text>
        }
        renderItem={({ item: line }) => (
          <View className="mx-4 mb-3 flex-row items-center rounded-2xl border border-neutral-200 bg-white p-4">
            <View className="flex-1">
              <Text className="text-base font-semibold text-neutral-900">{line.name}</Text>
              <Text className="mt-1 text-sm text-neutral-600">
                {t('common.price', { amount: line.unitPriceNpr })}
              </Text>
            </View>
            <View className="flex-row items-center gap-2">
              <Button
                label="−"
                size="sm"
                variant="secondary"
                accessibilityLabel={t('cart.decrease', { name: line.name })}
                onPress={() => {
                  setQuantity(line.productId, line.quantity - 1);
                }}
              />
              <Text className="min-w-6 text-center text-base font-semibold text-neutral-900">
                {formatLocalizedNumber(line.quantity, locale)}
              </Text>
              <Button
                label="+"
                size="sm"
                variant="secondary"
                disabled={line.quantity >= MAX_LINE_QUANTITY}
                accessibilityLabel={t('cart.increase', { name: line.name })}
                onPress={() => {
                  setQuantity(line.productId, line.quantity + 1);
                }}
              />
            </View>
            <Text className="ml-3 min-w-20 text-right text-base font-semibold text-neutral-900">
              {t('common.price', { amount: toNpr(toPaisa(line.unitPriceNpr) * line.quantity) })}
            </Text>
          </View>
        )}
      />
      <View className="gap-3 border-t border-neutral-200 bg-white p-4">
        <View className="flex-row justify-between">
          <Text className="text-base text-neutral-700">
            {t('cart.subtotal')} · {t('cart.itemCount', { count: itemCount })}
          </Text>
          <Text className="text-lg font-bold text-neutral-900">
            {t('common.price', { amount: cartTotal })}
          </Text>
        </View>
        <Button label={t('cart.clear')} variant="danger" onPress={clearCart} />
      </View>
    </View>
  );
}
