import type { VendorOrderView } from '@hamro-pasal/shared-types';
import { Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { Button } from '../../components/Button';
import { CashToCollect } from '../delivery/CashToCollect';
import { DeliveryOtpForm } from '../delivery/DeliveryOtpForm';

/** Short, human-readable order reference: the last 6 characters of the id (as the customer sees). */
export function vendorOrderCode(orderId: string): string {
  return orderId.replace(/-/g, '').slice(-6).toUpperCase();
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
}

/**
 * One order on the dashboard: what to pack, where it goes and how it is paid. A PLACED order has
 * the Accept / Reject buttons (vendor flow step 7); a PREPARING one has Dispatch (step 8); a
 * SELF_DELIVERY order out for delivery has the customer's 4-digit code field (step 9).
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
}: VendorOrderCardProps) {
  const { t } = useTranslation();
  const waiting = order.state === 'PLACED';
  const handOver = order.state === 'OUT_FOR_DELIVERY' && order.fulfillment === 'SELF_DELIVERY';
  const address = order.delivery_address;

  return (
    <View
      className={`gap-3 rounded-2xl p-4 ${waiting ? 'border-2 border-red-500 bg-red-50' : 'bg-white'}`}
      testID={`vendor-order-${order.id}`}
    >
      <View className="flex-row items-center justify-between">
        <Text className="text-lg font-bold text-neutral-900">
          {t('order.code', { code: vendorOrderCode(order.id) })}
        </Text>
        <Text className="text-base font-semibold text-neutral-900">
          {t('order.total', { amount: order.total_npr })}
        </Text>
      </View>
      <Text className="text-sm text-neutral-600">{t(`payment.${order.payment_method}`)}</Text>

      <View className="gap-1">
        {order.items.map((item) => (
          <Text key={item.product_id} className="text-base text-neutral-800">
            {t('vendorDashboard.item', { quantity: item.quantity, name: item.product_name })}
          </Text>
        ))}
      </View>

      <View className="gap-0.5">
        {address === null ? (
          <Text className="text-sm text-neutral-500">{t('vendorDashboard.noAddress')}</Text>
        ) : (
          <>
            <Text className="text-sm text-neutral-700">
              {t('vendorDashboard.address', {
                ward: address.ward_number,
                tole: address.tole_locality,
                palika: address.municipality_palika_string,
              })}
            </Text>
            <Text className="text-sm text-neutral-500">{address.landmark}</Text>
          </>
        )}
      </View>

      {waiting ? (
        <View className="flex-row gap-3">
          <View className="flex-1">
            <Button
              label={answered ? t('vendorDashboard.sending') : t('vendorDashboard.accept')}
              disabled={answered}
              onPress={onAccept}
              testID={`accept-${order.id}`}
            />
          </View>
          <View className="flex-1">
            <Button
              label={t('vendorDashboard.reject')}
              variant="danger"
              disabled={answered}
              onPress={onReject}
              testID={`reject-${order.id}`}
            />
          </View>
        </View>
      ) : null}

      {order.state === 'PREPARING' ? (
        <Button
          label={dispatching ? t('vendorDashboard.dispatching') : t('vendorDashboard.dispatch')}
          disabled={dispatching}
          onPress={onDispatch}
          testID={`dispatch-${order.id}`}
        />
      ) : null}

      {handOver ? (
        <>
          <Text className="text-sm text-neutral-600">{t('vendorDashboard.handoffHint')}</Text>
          <CashToCollect order={order} />
          <DeliveryOtpForm orderId={order.id} submitting={delivering} onSubmit={onDeliver} />
        </>
      ) : null}
    </View>
  );
}
