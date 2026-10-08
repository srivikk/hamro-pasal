import Ionicons from '@expo/vector-icons/Ionicons';
import { Redirect, router, Stack } from 'expo-router';
import { Alert, FlatList, Pressable, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { Button } from '../src/components/Button';
import {
  itemSummary,
  ORDER_STATE_TONE,
  orderCode,
  reorder,
} from '../src/features/order/order-history';
import { selectHasSession, useAuthStore } from '../src/store/useAuthStore';
import { useCartStore } from '../src/store/useCartStore';
import { selectIsCheckoutPending, useCheckoutStore } from '../src/store/useCheckoutStore';
import { useOrderReceiptStore, type OrderReceipt } from '../src/store/useOrderReceiptStore';
import { useOrderStore, type TrackedOrder } from '../src/store/useOrderStore';
import { useToastStore } from '../src/store/useToastStore';
import { colors } from '../src/theme/colors';

/** Newest first: by when the device saw the order placed; orders never seen placed go last. */
export function recentOrders(orders: Record<string, TrackedOrder>): TrackedOrder[] {
  return Object.values(orders).sort((a, b) => (b.placedAt ?? 0) - (a.placedAt ?? 0));
}

/**
 * "Your Orders" (from the Profile menu): the orders this phone has tracked, newest first. Each
 * card names the shop and where it is, the order's status, what was ordered and what it cost,
 * opens the order's detail screen, and can refill the cart ("Reorder").
 *
 * The list is the device's own record (useOrderStore + useOrderReceiptStore, at most 20): the API
 * has no order-list endpoint yet, so orders placed on another phone do not appear, and an order
 * this phone tracked without keeping its receipt shows its code, status and total only.
 */
export default function OrdersScreen() {
  const { t } = useTranslation();
  const signedIn = useAuthStore(selectHasSession);
  const orders = useOrderStore((state) => state.orders);
  const receipts = useOrderReceiptStore((state) => state.receipts);
  const checkoutPending = useCheckoutStore(selectIsCheckoutPending);
  const showToast = useToastStore((state) => state.show);

  if (!signedIn) return <Redirect href="/login" />;

  const onReorder = (receipt: OrderReceipt): void => {
    // A reservation is waiting for payment: the cart must not change underneath it.
    if (checkoutPending) {
      showToast(t('menu.checkoutPending'), 'info');
      return;
    }
    const finish = (replace: boolean): void => {
      reorder(receipt, replace);
      router.push('/cart');
    };
    if (reorder(receipt) === 'added') {
      router.push('/cart');
      return;
    }
    const current = useCartStore.getState().vendor?.name ?? '';
    Alert.alert(
      t('cartConflict.title'),
      t('cartConflict.message', { current, next: receipt.vendor.name }),
      [
        { text: t('cartConflict.cancel'), style: 'cancel' },
        {
          text: t('cartConflict.confirm'),
          style: 'destructive',
          onPress: () => {
            finish(true);
          },
        },
      ],
    );
  };

  return (
    <View className="flex-1 bg-gray-50">
      <Stack.Screen
        options={{
          headerShown: true,
          title: t('account.orders'),
          headerBackTitle: t('common.back'),
        }}
      />
      <FlatList
        data={recentOrders(orders)}
        keyExtractor={(order) => order.orderId}
        contentContainerStyle={{ padding: 16, gap: 12 }}
        ListEmptyComponent={
          <View className="items-center gap-3 pt-16" testID="orders-empty">
            <Ionicons name="receipt-outline" size={48} color={colors.inactive} />
            <Text className="text-center text-base text-gray-500">{t('orders.empty')}</Text>
          </View>
        }
        renderItem={({ item: order }) => {
          const receipt = receipts[order.orderId];
          const code = t('order.code', { code: orderCode(order.orderId) });
          return (
            <View className="rounded-2xl bg-white shadow-sm" testID={`order-card-${order.orderId}`}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={
                  receipt === undefined ? code : `${receipt.vendor.name}, ${code}`
                }
                testID={`order-row-${order.orderId}`}
                className="gap-3 p-4 active:opacity-70"
                onPress={() => {
                  router.push({ pathname: '/order/[id]', params: { id: order.orderId } });
                }}
              >
                <View className="flex-row items-start gap-3">
                  <View className="h-11 w-11 items-center justify-center rounded-xl bg-brand-light">
                    <Ionicons name="storefront" size={20} color={colors.brand} />
                  </View>
                  <View className="flex-1">
                    <Text className="text-base font-bold text-gray-900" numberOfLines={1}>
                      {receipt === undefined ? code : receipt.vendor.name}
                    </Text>
                    {receipt?.vendorLocation == null ? null : (
                      <Text className="text-sm text-gray-500" numberOfLines={1}>
                        {receipt.vendorLocation}
                      </Text>
                    )}
                    {receipt === undefined ? null : (
                      <Text className="text-xs text-gray-400">{code}</Text>
                    )}
                  </View>
                  <Text
                    testID={`order-status-${order.orderId}`}
                    className={`overflow-hidden rounded-full px-2.5 py-1 text-xs font-bold ${ORDER_STATE_TONE[order.state]}`}
                  >
                    {t(`orders.states.${order.state}`)}
                  </Text>
                </View>

                {receipt === undefined ? null : (
                  <Text
                    className="text-sm text-gray-700"
                    numberOfLines={1}
                    testID={`order-items-${order.orderId}`}
                  >
                    {itemSummary(receipt.items, t)}
                  </Text>
                )}
              </Pressable>

              <View className="mx-4 h-px bg-gray-100" />
              <View className="flex-row items-center justify-between p-4">
                <View>
                  <Text
                    className="text-base font-bold text-gray-900"
                    testID={`order-total-${order.orderId}`}
                  >
                    {t('order.total', { amount: order.totalNpr })}
                  </Text>
                  <Text className="text-xs text-gray-500">
                    {t(`payment.${order.paymentMethod}`)}
                  </Text>
                </View>
                {receipt === undefined ? null : (
                  <Button
                    label={t('orders.reorder')}
                    size="sm"
                    variant="secondary"
                    accessibilityLabel={t('orders.reorderFrom', { vendor: receipt.vendor.name })}
                    testID={`order-reorder-${order.orderId}`}
                    onPress={() => {
                      onReorder(receipt);
                    }}
                  />
                )}
              </View>
            </View>
          );
        }}
      />
    </View>
  );
}
