import { router, Stack, useLocalSearchParams } from 'expo-router';
import Ionicons from '@expo/vector-icons/Ionicons';
import { RefreshControl, ScrollView, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { Button } from '../../../src/components/Button';
import { OrderSkeleton } from '../../../src/components/Skeleton';
import { BillDetails } from '../../../src/features/order/BillDetails';
import { CancellationPanel } from '../../../src/features/order/CancellationPanel';
import {
  displayedOrderState,
  isCancelableState,
} from '../../../src/features/order/cancellation-window';
import { postDeliveryDeadline } from '../../../src/features/dispute/dispute-window';
import { DeliveryOtpBadge } from '../../../src/features/order/DeliveryOtpBadge';
import {
  useCancellationCountdown,
  useCancelOrder,
  useOrderQuery,
} from '../../../src/features/order/order-hooks';
import { ORDER_STATE_TONE, orderCode } from '../../../src/features/order/order-history';
import { isTerminalOrderState } from '../../../src/features/order/order-tracker';
import { OrderTracker } from '../../../src/features/order/OrderTracker';
import { useOrderRealtime } from '../../../src/features/order/useOrderRealtime';
import { demoTotalNpr, receiptMockSavingsNpr } from '../../../src/features/promo/demo-pricing';
import { toNpr, toPaisa } from '../../../src/lib/money';
import { useBeforeDeadline } from '../../../src/lib/useBeforeDeadline';
import { useAuthStore } from '../../../src/store/useAuthStore';
import { useDeliveryOtpStore } from '../../../src/store/useDeliveryOtpStore';
import { useOrderReceiptStore } from '../../../src/store/useOrderReceiptStore';
import { useOrderStore } from '../../../src/store/useOrderStore';
import { colors } from '../../../src/theme/colors';

/**
 * Leaves the order for the Home feed and drops everything under it: the cart and the payment
 * step an order was placed from must not be reachable again by going back.
 */
function backToHome(): void {
  if (router.canDismiss()) router.dismissAll();
  router.replace('/');
}

export default function OrderTrackingScreen() {
  const { t } = useTranslation();
  const { id } = useLocalSearchParams<{ id: string }>();
  const locale = useAuthStore((state) => state.locale);
  // The snapshot is hydrated from the device first (instant, offline-safe), then from the server.
  const order = useOrderStore((state) => state.orders[id]);
  const otp = useDeliveryOtpStore((state) => state.otps[id] ?? null);
  // What this phone kept at checkout: the shop, the items, the bill and the delivery address.
  const receipt = useOrderReceiptStore((state) => state.receipts[id]);
  const query = useOrderQuery(id);
  // Real-time state over Socket.io /orders until the order is finished (no polling).
  useOrderRealtime(id, order === undefined || !isTerminalOrderState(order.state));
  const cancel = useCancelOrder();
  const remainingMs = useCancellationCountdown(order?.placedAt ?? null);
  // SPEC journey step 11: disputes may be opened for 48 h after delivery.
  const disputeWindowOpen = useBeforeDeadline(postDeliveryDeadline(order?.deliveredAt ?? null));

  const header = (
    // No back button and no back swipe: the way out of an order is "Back to Home" below.
    <Stack.Screen
      options={{
        headerShown: true,
        title: t('order.title'),
        headerBackVisible: false,
        headerLeft: () => null,
        gestureEnabled: false,
      }}
    />
  );

  if (order === undefined) {
    if (!query.isError) {
      return (
        <View className="flex-1 bg-gray-50">
          {header}
          <OrderSkeleton testID="order-loading" />
        </View>
      );
    }
    return (
      <View className="flex-1 items-center justify-center gap-4 bg-gray-50 px-6">
        {header}
        <Text className="text-center text-base text-gray-700">{t('order.loadError')}</Text>
        <Button label={t('common.retry')} onPress={() => void query.refetch()} />
        <Button
          label={t('order.backHome')}
          variant="secondary"
          testID="order-back-home"
          onPress={backToHome}
        />
      </View>
    );
  }

  const windowOpen = isCancelableState(order.state) && remainingMs > 0;
  const shownState = displayedOrderState(order.state, windowOpen);
  const terminal = isTerminalOrderState(order.state);

  return (
    <ScrollView
      className="flex-1 bg-gray-50"
      contentContainerStyle={{ padding: 16, gap: 16 }}
      refreshControl={
        <RefreshControl refreshing={query.isRefetching} onRefresh={() => void query.refetch()} />
      }
    >
      {header}
      <View className="flex-row items-start gap-3">
        <View className="flex-1">
          {receipt === undefined ? null : (
            <Text className="text-xl font-extrabold text-gray-900" testID="order-vendor">
              {receipt.vendor.name}
            </Text>
          )}
          {receipt?.vendorLocation == null ? null : (
            <Text className="text-sm text-gray-500">{receipt.vendorLocation}</Text>
          )}
          <Text
            className={
              receipt === undefined
                ? 'text-xl font-bold text-gray-900'
                : 'mt-1 text-sm font-semibold text-gray-700'
            }
          >
            {t('order.code', { code: orderCode(order.orderId) })}
          </Text>
          <Text className="mt-1 text-sm text-gray-500">
            {/* TODO: Remove mock pricing when /cart/quote is ready. (demoTotalNpr) */}
            {t('order.total', {
              amount: demoTotalNpr(order.totalNpr, receiptMockSavingsNpr(receipt)),
            })}{' '}
            · {t(`payment.${order.paymentMethod}`)}
          </Text>
        </View>
        <Text
          testID="order-status"
          className={`overflow-hidden rounded-full px-2.5 py-1 text-xs font-bold ${ORDER_STATE_TONE[order.state]}`}
        >
          {t(`orders.states.${order.state}`)}
        </Text>
      </View>

      {order.state === 'CANCELED' || order.state === 'FAILED' ? (
        <View className="rounded-2xl bg-red-50 p-4" testID="order-ended">
          <Text className="text-lg font-bold text-red-800">
            {order.state === 'CANCELED' ? t('order.cancelledTitle') : t('order.failedTitle')}
          </Text>
        </View>
      ) : null}

      {windowOpen ? (
        <CancellationPanel
          remainingMs={remainingMs}
          locale={locale}
          cancelling={cancel.isPending}
          onCancel={() => {
            cancel.mutate({ orderId: order.orderId });
          }}
        />
      ) : null}

      {terminal ? null : <DeliveryOtpBadge otp={otp} locale={locale} />}

      {/* The order's timeline: discrete state nodes (SPEC journey step 9). */}
      <OrderTracker state={shownState} />

      {receipt === undefined ? null : (
        <View className="gap-3 rounded-2xl bg-white p-4 shadow-sm" testID="order-items">
          <Text className="text-base font-bold text-gray-900">{t('bill.items')}</Text>
          {receipt.items.map((item) => (
            <View key={item.productId} className="flex-row items-start justify-between gap-3">
              <Text className="flex-1 text-sm text-gray-700">
                {t('orders.itemLine', { quantity: item.quantity, name: item.name })}
              </Text>
              <Text className="text-sm text-gray-900">
                {t('common.price', {
                  amount: toNpr(toPaisa(item.unitPriceNpr) * item.quantity),
                })}
              </Text>
            </View>
          ))}
        </View>
      )}

      <BillDetails
        receipt={receipt}
        serverTotalNpr={order.totalNpr}
        paymentMethod={order.paymentMethod}
      />

      {receipt?.deliveryAddress == null ? null : (
        <View className="gap-2 rounded-2xl bg-white p-4 shadow-sm" testID="order-address">
          <Text className="text-base font-bold text-gray-900">{t('bill.deliveredTo')}</Text>
          <View className="flex-row items-start gap-2">
            <Ionicons name="location-outline" size={16} color={colors.inactive} />
            <Text className="flex-1 text-sm leading-5 text-gray-700">
              {receipt.deliveryAddress}
            </Text>
          </View>
        </View>
      )}

      {order.state === 'DELIVERED' && disputeWindowOpen ? (
        <Button
          label={t('dispute.open')}
          variant="secondary"
          onPress={() => {
            router.push({ pathname: '/order/[id]/dispute', params: { id: order.orderId } });
          }}
        />
      ) : null}

      <Button
        label={t('order.backHome')}
        variant="secondary"
        testID="order-back-home"
        onPress={backToHome}
      />
    </ScrollView>
  );
}
