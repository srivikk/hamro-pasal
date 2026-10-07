import { ORDER_CANCELLATION_WINDOW_SECONDS, type VendorOrderView } from '@hamro-pasal/shared-types';
import { useEffect } from 'react';
import { Text, View } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import { useTranslation } from 'react-i18next';

import { Button } from '../../components/Button';
import { useSecondsUntil } from '../../lib/countdown';
import { CashToCollect } from '../delivery/CashToCollect';
import { DeliveryOtpForm } from '../delivery/DeliveryOtpForm';

/** Short, human-readable order reference: the last 6 characters of the id (as the customer sees). */
export function vendorOrderCode(orderId: string): string {
  return orderId.replace(/-/g, '').slice(-6).toUpperCase();
}

/** A red dot that fades in and out (on the UI thread) while an order waits for an answer. */
function PulseDot({ testID }: { testID: string }) {
  const opacity = useSharedValue(1);
  useEffect(() => {
    opacity.value = withRepeat(withTiming(0.2, { duration: 700 }), -1, true);
  }, [opacity]);
  const pulse = useAnimatedStyle(() => ({ opacity: opacity.value }));
  return (
    <Animated.View testID={testID} style={pulse} className="h-3 w-3 rounded-full bg-red-600" />
  );
}

/**
 * "Ready for Pickup" on a Preparing order. The customer may cancel for 60 seconds after placing
 * the order and the server refuses a dispatch inside that window (422 CANCELLATION_WINDOW_OPEN),
 * so the button stays disabled, counting down, until the window has closed. The countdown runs on
 * the device's clock against the server's `placed_at`: it is a guard rail, the server still decides.
 */
function ReadyButton({
  order,
  dispatching,
  onDispatch,
}: {
  order: VendorOrderView;
  dispatching: boolean;
  onDispatch: () => void;
}) {
  const { t } = useTranslation();
  const seconds = useSecondsUntil(
    Date.parse(order.placed_at) + ORDER_CANCELLATION_WINDOW_SECONDS * 1000,
  );
  const waiting = seconds > 0;
  return (
    <View className="gap-1">
      <Button
        label={
          dispatching
            ? t('vendorDashboard.dispatching')
            : waiting
              ? t('vendorDashboard.dispatchIn', { seconds })
              : t('vendorDashboard.dispatch')
        }
        disabled={dispatching || waiting}
        onPress={onDispatch}
        testID={`dispatch-${order.id}`}
      />
      {waiting ? (
        <Text className="text-center text-sm text-gray-500" testID={`dispatch-wait-${order.id}`}>
          {t('vendorDashboard.dispatchWait')}
        </Text>
      ) : null}
    </View>
  );
}

export interface VendorOrderCardProps {
  order: VendorOrderView;
  /** The vendor answered and the request is in flight (or the answer is being confirmed). */
  answered: boolean;
  onAccept: () => void;
  onReject: () => void;
  /** The dispatch request for this order is in flight. */
  dispatching: boolean;
  onDispatch: () => void;
  /** The customer's code for this order is being checked. */
  delivering: boolean;
  /** Sends the typed code; `onRejected` clears the field. */
  onDeliver: (otp: string, onRejected: () => void) => void;
  /** The customer's first name, when known. */
  customerName?: string | null;
  /** "4 min ago": how long since the order was placed. */
  elapsed?: string;
  /** A sample order (development builds): tagged so it is never taken for a real one. */
  sample?: boolean;
  /** A fleet order the riders were told about that none has collected yet (Ready). */
  awaitingRider?: boolean;
  /** Samples only: stands in for the rider confirming the pickup. */
  onRiderPickup?: (() => void) | undefined;
}

/**
 * One order on the dashboard: who it is for, what to pack, where it goes and how it is paid. A
 * PLACED order pulses and has the Accept / Reject buttons (vendor flow step 7); a PREPARING one
 * has Ready for Pickup, which dispatches it (step 8); a SELF_DELIVERY order out for delivery has
 * the customer's 4-digit code field (step 9), and a fleet order says whether its rider has come.
 */
export function VendorOrderCard({
  order,
  answered,
  onAccept,
  onReject,
  dispatching,
  onDispatch,
  delivering,
  onDeliver,
  customerName = null,
  elapsed,
  sample = false,
  awaitingRider = false,
  onRiderPickup,
}: VendorOrderCardProps) {
  const { t } = useTranslation();
  const waiting = order.state === 'PLACED';
  const handOver = order.state === 'OUT_FOR_DELIVERY' && order.fulfillment === 'SELF_DELIVERY';
  const withRider = order.state === 'OUT_FOR_DELIVERY' && !handOver;
  const address = order.delivery_address;

  return (
    <View
      className={`gap-3 rounded-2xl p-4 ${waiting ? 'border-2 border-red-500 bg-red-50' : 'bg-white'}`}
      testID={`vendor-order-${order.id}`}
    >
      <View className="flex-row items-center justify-between">
        <View className="flex-row items-center gap-2">
          {waiting && !answered ? <PulseDot testID={`order-pulse-${order.id}`} /> : null}
          <Text className="text-lg font-bold text-gray-900">
            {t('order.code', { code: vendorOrderCode(order.id) })}
          </Text>
          {sample ? (
            <Text className="rounded bg-gray-200 px-1.5 py-0.5 text-xs font-semibold text-gray-700">
              {t('vendorDashboard.sample')}
            </Text>
          ) : null}
        </View>
        <Text className="text-base font-semibold text-gray-900">
          {t('order.total', { amount: order.total_npr })}
        </Text>
      </View>
      <View className="flex-row items-center justify-between">
        <Text
          className="text-base font-semibold text-gray-800"
          testID={`order-customer-${order.id}`}
        >
          {customerName ?? t('vendorDashboard.customer')}
        </Text>
        {elapsed === undefined ? null : (
          <Text className="text-sm text-gray-500" testID={`order-elapsed-${order.id}`}>
            {elapsed}
          </Text>
        )}
      </View>
      <Text className="text-sm text-gray-500">{t(`payment.${order.payment_method}`)}</Text>

      <View className="gap-1">
        {order.items.map((item) => (
          <Text key={item.product_id} className="text-base text-gray-800">
            {t('vendorDashboard.item', { quantity: item.quantity, name: item.product_name })}
          </Text>
        ))}
      </View>

      <View className="gap-0.5">
        {address === null ? (
          <Text className="text-sm text-gray-500">{t('vendorDashboard.noAddress')}</Text>
        ) : (
          <>
            <Text className="text-sm text-gray-700">
              {t('vendorDashboard.address', {
                ward: address.ward_number,
                tole: address.tole_locality,
                palika: address.municipality_palika_string,
              })}
            </Text>
            <Text className="text-sm text-gray-500">{address.landmark}</Text>
          </>
        )}
      </View>

      {waiting ? (
        <View className="gap-2">
          <Button
            label={answered ? t('vendorDashboard.sending') : t('vendorDashboard.accept')}
            disabled={answered}
            onPress={onAccept}
            testID={`accept-${order.id}`}
          />
          <Button
            label={t('vendorDashboard.reject')}
            variant="danger"
            size="sm"
            disabled={answered}
            onPress={onReject}
            testID={`reject-${order.id}`}
          />
        </View>
      ) : null}

      {order.state === 'PREPARING' ? (
        <ReadyButton order={order} dispatching={dispatching} onDispatch={onDispatch} />
      ) : null}

      {handOver ? (
        <>
          <Text className="text-sm text-gray-500">{t('vendorDashboard.handoffHint')}</Text>
          <CashToCollect order={order} />
          <DeliveryOtpForm orderId={order.id} submitting={delivering} onSubmit={onDeliver} />
        </>
      ) : null}

      {withRider ? (
        <Text className="text-sm text-gray-500" testID={`order-rider-${order.id}`}>
          {t(awaitingRider ? 'vendorDashboard.awaitingRider' : 'vendorDashboard.withRider')}
        </Text>
      ) : null}
      {withRider && awaitingRider && onRiderPickup !== undefined ? (
        <Button
          label={t('vendorDashboard.samplePickup')}
          variant="secondary"
          size="sm"
          onPress={onRiderPickup}
          testID={`rider-pickup-${order.id}`}
        />
      ) : null}
      {order.state === 'DELIVERED' ? (
        <Text className="text-sm font-semibold text-emerald-700">
          {t('vendorDashboard.delivered')}
        </Text>
      ) : null}
    </View>
  );
}
