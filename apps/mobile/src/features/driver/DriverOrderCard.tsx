import type { DriverOrderView } from '@hamro-pasal/shared-types';
import { Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { CashToCollect } from '../delivery/CashToCollect';
import { DeliveryOtpForm } from '../delivery/DeliveryOtpForm';
import { vendorOrderCode } from '../vendor/VendorOrderCard';

export interface DriverOrderCardProps {
  order: DriverOrderView;
  /** This order's code is being checked by the server. */
  submitting: boolean;
  /** Sends the typed code; `onRejected` clears the field so the rider types it afresh. */
  onDeliver: (otp: string, onRejected: () => void) => void;
}

/**
 * One gig on the rider's dashboard (driver flow steps 3–5): the shop, the drop-off address, the
 * items, the cash to collect, and the field for the customer's 4-digit code.
 */
export function DriverOrderCard({ order, submitting, onDeliver }: DriverOrderCardProps) {
  const { t } = useTranslation();
  const address = order.delivery_address;

  return (
    <View className="gap-3 rounded-2xl bg-white p-4" testID={`driver-order-${order.id}`}>
      <View className="flex-row items-center justify-between">
        <Text className="text-lg font-bold text-neutral-900">
          {t('order.code', { code: vendorOrderCode(order.id) })}
        </Text>
        <Text className="text-sm text-neutral-600">
          {order.assigned_to_me ? t('driverDashboard.mine') : t('driverDashboard.unclaimed')}
        </Text>
      </View>

      <Text className="text-base text-neutral-800">
        {t('driverDashboard.pickup', { shop: order.vendor_business_name })}
      </Text>

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

      <View className="gap-1">
        {order.items.map((item) => (
          <Text key={item.product_id} className="text-sm text-neutral-700">
            {t('vendorDashboard.item', { quantity: item.quantity, name: item.product_name })}
          </Text>
        ))}
      </View>

      <CashToCollect order={order} />
      <DeliveryOtpForm orderId={order.id} submitting={submitting} onSubmit={onDeliver} />
    </View>
  );
}
