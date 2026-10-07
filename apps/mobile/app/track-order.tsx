import Ionicons from '@expo/vector-icons/Ionicons';
import { Redirect, router, Stack, useLocalSearchParams } from 'expo-router';
import { Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { Button } from '../src/components/Button';
import { isTerminalOrderState } from '../src/features/order/order-tracker';
import { selectHasSession, useAuthStore } from '../src/store/useAuthStore';
import { useOrderStore, type TrackedOrder } from '../src/store/useOrderStore';
import { colors } from '../src/theme/colors';

/**
 * The order to open when none is named: the newest one still on its way, else the newest of all
 * (by when this phone saw it placed). Null when the phone has tracked no order.
 */
export function orderToTrack(orders: Record<string, TrackedOrder>): string | null {
  const newestFirst = Object.values(orders).sort((a, b) => (b.placedAt ?? 0) - (a.placedAt ?? 0));
  const active = newestFirst.find((order) => !isTerminalOrderState(order.state));
  return (active ?? newestFirst[0])?.orderId ?? null;
}

/**
 * `/track-order[?id=<order id>]`: the one way into order tracking. The cart's "Track order"
 * button and a tapped order notification come here with the order's id; without one the newest
 * order is chosen. It hands over to the live tracking screen (`/order/[id]`: the discrete state
 * nodes, the 60 s cancel window, the delivery code), replacing itself so Back returns to where
 * the customer came from. With nothing to track it says so.
 */
export default function TrackOrderScreen() {
  const { t } = useTranslation();
  const { id } = useLocalSearchParams<{ id?: string }>();
  const signedIn = useAuthStore(selectHasSession);
  const orders = useOrderStore((state) => state.orders);

  if (!signedIn) return <Redirect href="/login" />;

  const orderId = typeof id === 'string' && id !== '' ? id : orderToTrack(orders);
  if (orderId !== null) {
    return <Redirect href={{ pathname: '/order/[id]', params: { id: orderId } }} />;
  }

  return (
    <View className="flex-1 items-center justify-center gap-4 bg-gray-50 px-6" testID="track-empty">
      <Stack.Screen
        options={{ headerShown: true, title: t('order.track'), headerBackTitle: t('common.back') }}
      />
      <Ionicons name="bicycle-outline" size={56} color={colors.inactive} />
      <Text className="text-center text-xl font-bold text-gray-900">
        {t('trackOrder.emptyTitle')}
      </Text>
      <Text className="text-center text-base text-gray-500">{t('trackOrder.emptyBody')}</Text>
      <Button
        label={t('trackOrder.browse')}
        onPress={() => {
          router.replace('/');
        }}
      />
    </View>
  );
}
