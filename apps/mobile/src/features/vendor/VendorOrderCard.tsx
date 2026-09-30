import type { VendorOrderView } from '@hamro-pasal/shared-types';
import { Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { Button } from '../../components/Button';

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
}

/**
 * One order on the dashboard: what to pack, where it goes and how it is paid. A PLACED order has
 * the Accept / Reject buttons (vendor flow step 7); an accepted one is shown as Preparing.
 */
export function VendorOrderCard({ order, answered, onAccept, onReject }: VendorOrderCardProps) {
  const { t } = useTranslation();
  const waiting = order.state === 'PLACED';
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
    </View>
  );
}
