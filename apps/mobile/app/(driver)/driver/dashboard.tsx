import { Stack } from 'expo-router';
import { ActivityIndicator, RefreshControl, ScrollView, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { useSignOut } from '../../../src/api/auth';
import { Button } from '../../../src/components/Button';
import { DriverOrderCard } from '../../../src/features/driver/DriverOrderCard';
import {
  useDeliverOrder,
  useDriverOrdersQuery,
} from '../../../src/features/driver/useDriverOrders';

/**
 * Delivery partner flow steps 3–5: the rider's orders out for delivery. At the door the rider types
 * the customer's 4-digit code; a match delivers the order (it leaves the list), a wrong code says
 * how many tries are left, and five wrong codes lock the order for a while.
 */
export default function DriverDashboardScreen() {
  const { t } = useTranslation();
  const signOut = useSignOut();
  const query = useDriverOrdersQuery();
  const { deliver, pendingOrderId } = useDeliverOrder();
  const header = (
    <Stack.Screen options={{ headerShown: true, title: t('driverDashboard.title') }} />
  );

  if (query.data === undefined) {
    return (
      <View className="flex-1 items-center justify-center gap-4 bg-neutral-50 px-6">
        {header}
        {query.isError ? (
          <>
            <Text className="text-center text-base text-neutral-700">
              {t('driverDashboard.loadError')}
            </Text>
            <Button label={t('common.retry')} onPress={() => void query.refetch()} />
          </>
        ) : (
          <ActivityIndicator testID="driver-orders-loading" />
        )}
      </View>
    );
  }

  const orders = query.data;

  return (
    <ScrollView
      className="flex-1 bg-neutral-50"
      contentContainerStyle={{ padding: 16, gap: 16 }}
      keyboardShouldPersistTaps="handled"
      refreshControl={
        <RefreshControl refreshing={query.isRefetching} onRefresh={() => void query.refetch()} />
      }
    >
      {header}
      {orders.length === 0 ? (
        <Text className="text-center text-base text-neutral-600" testID="driver-orders-empty">
          {t('driverDashboard.empty')}
        </Text>
      ) : (
        orders.map((order) => (
          <DriverOrderCard
            key={order.id}
            order={order}
            submitting={pendingOrderId === order.id}
            onDeliver={(otp, onRejected) => {
              deliver({ orderId: order.id, otp }, { onError: onRejected });
            }}
          />
        ))
      )}

      <Button label={t('auth.signOut')} variant="secondary" onPress={signOut} />
    </ScrollView>
  );
}
