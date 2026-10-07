import { Stack } from 'expo-router';
import { ActivityIndicator, RefreshControl, ScrollView, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { useSignOut } from '../../../src/api/auth';
import { Button } from '../../../src/components/Button';
import { DeliveryCard } from '../../../src/features/driver/DeliveryCard';
import { RiderGpsSimulator } from '../../../src/features/driver/RiderGpsSimulator';
import {
  useCompleteDelivery,
  useDeliveriesQuery,
  useDeliveryStep,
} from '../../../src/features/driver/useDeliveries';

/**
 * Delivery partner flow ("Rider Mode"): open gigs and the rider's own deliveries. The rider
 * accepts a gig, marks it picked up, and at the door types the customer's 4-digit code; a match
 * delivers the order (it leaves the list), a wrong code says how many tries are left, and five
 * wrong codes lock the order for a while. The GPS switch streams mock positions for testing.
 */
export default function DriverDashboardScreen() {
  const { t } = useTranslation();
  const signOut = useSignOut();
  const query = useDeliveriesQuery();
  const { advance, pendingDeliveryId: advancingId } = useDeliveryStep();
  const { complete, pendingDeliveryId: completingId } = useCompleteDelivery();
  const header = (
    <Stack.Screen options={{ headerShown: true, title: t('driverDashboard.title') }} />
  );

  if (query.data === undefined) {
    return (
      <View className="flex-1 items-center justify-center gap-4 bg-gray-50 px-6">
        {header}
        {query.isError ? (
          <>
            <Text className="text-center text-base text-gray-700">
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

  const deliveries = query.data;

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
      <RiderGpsSimulator />
      {deliveries.length === 0 ? (
        <Text className="text-center text-base text-gray-500" testID="driver-orders-empty">
          {t('driverDashboard.empty')}
        </Text>
      ) : (
        deliveries.map((delivery) => (
          <DeliveryCard
            key={delivery.id}
            delivery={delivery}
            advancing={advancingId === delivery.id}
            submitting={completingId === delivery.id}
            onAdvance={(step) => {
              advance({ deliveryId: delivery.id, step });
            }}
            onComplete={(otp, onRejected) => {
              complete({ deliveryId: delivery.id, otp }, { onError: onRejected });
            }}
          />
        ))
      )}

      <Button label={t('auth.signOut')} variant="secondary" onPress={signOut} />
    </ScrollView>
  );
}
