import { router, Stack } from 'expo-router';
import { ActivityIndicator, RefreshControl, ScrollView, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { useSignOut } from '../../src/api/auth';
import { Button } from '../../src/components/Button';
import {
  isAlarmRinging,
  useVendorDelivery,
  useVendorDispatch,
  useVendorOrderDecisions,
  useVendorOrdersQuery,
  useVendorOrdersRealtime,
} from '../../src/features/vendor/useVendorOrders';
import { useVendorAlarm } from '../../src/features/vendor/vendor-alarm';
import { VendorOrderCard } from '../../src/features/vendor/VendorOrderCard';

/**
 * Vendor flow steps 6–9: the shop's incoming orders. A new order arrives over Socket.io `/orders`
 * (the shop's room), the alarm loops at full volume until the vendor presses Accept or Reject on
 * every waiting order, and accepted orders stay listed as Preparing with a Dispatch button (refused
 * until the customer's 60 s cancellation window has closed). The shop's own deliveries then stay
 * listed as Out for delivery, where the customer's 4-digit code is typed at the door. If the vendor
 * does not answer a new order within 90 s the backend escalates to an IVR call / SMS.
 */
export default function VendorDashboardScreen() {
  const { t } = useTranslation();
  const signOut = useSignOut();
  const query = useVendorOrdersQuery();
  useVendorOrdersRealtime(true);
  const { decide, acknowledged } = useVendorOrderDecisions();
  const { dispatch, pendingOrderId: dispatchingId } = useVendorDispatch();
  const { deliver, pendingOrderId: deliveringId } = useVendorDelivery();
  const ringing = isAlarmRinging(query.data, acknowledged);
  useVendorAlarm(ringing);

  const orders = query.data ?? [];
  const waiting = orders.filter((order) => order.state === 'PLACED');
  const preparing = orders.filter((order) => order.state === 'PREPARING');
  const onTheRoad = orders.filter((order) => order.state === 'OUT_FOR_DELIVERY');
  const header = (
    <Stack.Screen options={{ headerShown: true, title: t('vendorDashboard.title') }} />
  );

  if (query.data === undefined) {
    return (
      <View className="flex-1 items-center justify-center gap-4 bg-gray-50 px-6">
        {header}
        {query.isError ? (
          <>
            <Text className="text-center text-base text-gray-700">
              {t('vendorDashboard.loadError')}
            </Text>
            <Button label={t('common.retry')} onPress={() => void query.refetch()} />
          </>
        ) : (
          <ActivityIndicator testID="vendor-orders-loading" />
        )}
      </View>
    );
  }

  const card = (order: (typeof orders)[number]) => (
    <VendorOrderCard
      key={order.id}
      order={order}
      answered={acknowledged.has(order.id)}
      onAccept={() => {
        decide({ orderId: order.id, decision: 'accept' });
      }}
      onReject={() => {
        decide({ orderId: order.id, decision: 'reject' });
      }}
      dispatching={dispatchingId === order.id}
      onDispatch={() => {
        dispatch(order.id);
      }}
      delivering={deliveringId === order.id}
      onDeliver={(otp, onRejected) => {
        deliver({ orderId: order.id, otp }, { onError: onRejected });
      }}
    />
  );

  return (
    <ScrollView
      className="flex-1 bg-gray-50"
      contentContainerStyle={{ padding: 16, gap: 16 }}
      keyboardShouldPersistTaps="handled"
      refreshControl={
        <RefreshControl refreshing={query.isRefetching} onRefresh={() => void query.refetch()} />
      }
    >
      {header}
      {ringing ? (
        <View className="rounded-2xl bg-red-600 p-4" testID="vendor-alarm-banner">
          <Text className="text-base font-bold text-white">{t('vendorDashboard.alarm')}</Text>
        </View>
      ) : null}

      {orders.length === 0 ? (
        <Text className="text-center text-base text-gray-500" testID="vendor-orders-empty">
          {t('vendorDashboard.empty')}
        </Text>
      ) : null}

      {waiting.length > 0 ? (
        <View className="gap-3">
          <Text className="text-lg font-bold text-gray-900">{t('vendorDashboard.newOrders')}</Text>
          {waiting.map(card)}
        </View>
      ) : null}

      {preparing.length > 0 ? (
        <View className="gap-3">
          <Text className="text-lg font-bold text-gray-900">{t('vendorDashboard.preparing')}</Text>
          {preparing.map(card)}
        </View>
      ) : null}

      {onTheRoad.length > 0 ? (
        <View className="gap-3">
          <Text className="text-lg font-bold text-gray-900">
            {t('vendorDashboard.outForDelivery')}
          </Text>
          {onTheRoad.map(card)}
        </View>
      ) : null}

      <Button
        label={t('vendorDashboard.wallet')}
        variant="secondary"
        testID="vendor-wallet-link"
        onPress={() => {
          router.push('/wallet');
        }}
      />
      <Button label={t('auth.signOut')} variant="secondary" onPress={signOut} />
    </ScrollView>
  );
}
