import { router, Stack, useLocalSearchParams } from 'expo-router';
import { ActivityIndicator, RefreshControl, ScrollView, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { Button } from '../../../src/components/Button';
import { CancellationPanel } from '../../../src/features/order/CancellationPanel';
import { displayedOrderState } from '../../../src/features/order/cancellation-window';
import { postDeliveryDeadline } from '../../../src/features/dispute/dispute-window';
import { DeliveryOtpBadge } from '../../../src/features/order/DeliveryOtpBadge';
import {
  useCancellationCountdown,
  useCancelOrder,
  useOrderQuery,
} from '../../../src/features/order/order-hooks';
import { isTerminalOrderState } from '../../../src/features/order/order-tracker';
import { OrderTracker } from '../../../src/features/order/OrderTracker';
import { useBeforeDeadline } from '../../../src/lib/useBeforeDeadline';
import { useAuthStore } from '../../../src/store/useAuthStore';
import { useDeliveryOtpStore } from '../../../src/store/useDeliveryOtpStore';
import { useOrderStore } from '../../../src/store/useOrderStore';

/** Short, human-readable order reference: the last 6 characters of the id. */
function orderCode(orderId: string): string {
  return orderId.replace(/-/g, '').slice(-6).toUpperCase();
}

export default function OrderTrackingScreen() {
  const { t } = useTranslation();
  const { id } = useLocalSearchParams<{ id: string }>();
  const locale = useAuthStore((state) => state.locale);
  // The snapshot is hydrated from the device first (instant, offline-safe), then from the server.
  const order = useOrderStore((state) => state.orders[id]);
  const otp = useDeliveryOtpStore((state) => state.otps[id] ?? null);
  const query = useOrderQuery(id);
  const cancel = useCancelOrder();
  const remainingMs = useCancellationCountdown(order?.placedAt ?? null);
  // SPEC journey step 11: disputes may be opened for 48 h after delivery.
  const disputeWindowOpen = useBeforeDeadline(postDeliveryDeadline(order?.deliveredAt ?? null));

  const header = (
    <Stack.Screen
      options={{ headerShown: true, title: t('order.title'), headerBackTitle: t('common.back') }}
    />
  );

  if (order === undefined) {
    return (
      <View className="flex-1 items-center justify-center gap-4 bg-neutral-50 px-6">
        {header}
        {query.isError ? (
          <>
            <Text className="text-center text-base text-neutral-700">{t('order.loadError')}</Text>
            <Button label={t('common.retry')} onPress={() => void query.refetch()} />
          </>
        ) : (
          <ActivityIndicator testID="order-loading" />
        )}
      </View>
    );
  }

  const windowOpen = order.state === 'PLACED' && remainingMs > 0;
  const shownState = displayedOrderState(order.state, windowOpen);
  const terminal = isTerminalOrderState(order.state);

  return (
    <ScrollView
      className="flex-1 bg-neutral-50"
      contentContainerStyle={{ padding: 16, gap: 16 }}
      refreshControl={
        <RefreshControl refreshing={query.isRefetching} onRefresh={() => void query.refetch()} />
      }
    >
      {header}
      <View>
        <Text className="text-xl font-bold text-neutral-900">
          {t('order.code', { code: orderCode(order.orderId) })}
        </Text>
        <Text className="mt-1 text-sm text-neutral-600">
          {t('order.total', { amount: order.totalNpr })} · {t(`payment.${order.paymentMethod}`)}
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

      <OrderTracker state={shownState} />

      {order.state === 'DELIVERED' && disputeWindowOpen ? (
        <Button
          label={t('dispute.open')}
          variant="secondary"
          onPress={() => {
            router.push({ pathname: '/order/[id]/dispute', params: { id: order.orderId } });
          }}
        />
      ) : null}
    </ScrollView>
  );
}
