import type { DeliveryView } from '@hamro-pasal/shared-types';
import { Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import type { DeliveryStep } from '../../api/deliveries';
import { Button } from '../../components/Button';
import { CashToCollect } from '../delivery/CashToCollect';
import { DeliveryOtpForm } from '../delivery/DeliveryOtpForm';
import { vendorOrderCode } from '../vendor/VendorOrderCard';

export interface DeliveryCardProps {
  delivery: DeliveryView;
  /** This delivery's accept / pickup is being sent. */
  advancing: boolean;
  /** This delivery's code is being checked by the server. */
  submitting: boolean;
  onAdvance: (step: DeliveryStep) => void;
  /** Sends the typed code; `onRejected` clears the field so the rider types it afresh. */
  onComplete: (otp: string, onRejected: () => void) => void;
}

/**
 * One delivery on the rider's dashboard (delivery partner flow): the shop, the drop-off address,
 * the items, the cash to collect, and the one action its state allows: Accept an open gig, mark
 * it Picked up, then the field for the customer's 4-digit code.
 */
export function DeliveryCard({
  delivery,
  advancing,
  submitting,
  onAdvance,
  onComplete,
}: DeliveryCardProps) {
  const { t } = useTranslation();
  const { order } = delivery;
  const address = order.delivery_address;

  return (
    <View className="gap-3 rounded-2xl bg-white p-4" testID={`delivery-${delivery.id}`}>
      <View className="flex-row items-center justify-between">
        <Text className="text-lg font-bold text-neutral-900">
          {t('order.code', { code: vendorOrderCode(order.id) })}
        </Text>
        <Text className="text-sm text-neutral-600" testID={`delivery-state-${delivery.id}`}>
          {t(`driverDashboard.state.${delivery.state}`)}
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

      {delivery.state === 'OFFERED' ? (
        <Button
          testID={`delivery-accept-${delivery.id}`}
          label={t(advancing ? 'driverDashboard.sending' : 'driverDashboard.accept')}
          disabled={advancing}
          onPress={() => {
            onAdvance('accept');
          }}
        />
      ) : null}
      {delivery.state === 'ASSIGNED' ? (
        <Button
          testID={`delivery-pickup-${delivery.id}`}
          label={t(advancing ? 'driverDashboard.sending' : 'driverDashboard.markPickedUp')}
          disabled={advancing}
          onPress={() => {
            onAdvance('pickup');
          }}
        />
      ) : null}
      {delivery.state === 'PICKED_UP' ? (
        <DeliveryOtpForm orderId={order.id} submitting={submitting} onSubmit={onComplete} />
      ) : null}
    </View>
  );
}
