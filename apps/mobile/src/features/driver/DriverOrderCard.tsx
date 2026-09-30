import { DELIVERY_OTP_LENGTH, type DriverOrderView } from '@hamro-pasal/shared-types';
import { useState } from 'react';
import { Text, TextInput, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { Button } from '../../components/Button';
import { vendorOrderCode } from '../vendor/VendorOrderCard';
import { isCompleteDeliveryOtp, sanitizeDeliveryOtpInput } from './delivery-otp-input';

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
  const [code, setCode] = useState('');
  const address = order.delivery_address;
  const cod = order.payment_method === 'COD' && order.payment_status !== 'PAID';
  const canSubmit = isCompleteDeliveryOtp(code) && !submitting;

  const submit = (): void => {
    if (!canSubmit) return;
    onDeliver(code, () => {
      setCode('');
    });
  };

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

      <Text
        className={`text-base font-semibold ${cod ? 'text-red-700' : 'text-neutral-700'}`}
        testID={`driver-cash-${order.id}`}
      >
        {cod
          ? t('driverDashboard.collectCash', { amount: order.total_npr })
          : t('driverDashboard.prepaid')}
      </Text>

      <View className="gap-2">
        <Text className="text-sm font-medium text-neutral-700">
          {t('driverDashboard.codeLabel')}
        </Text>
        <TextInput
          testID={`delivery-otp-${order.id}`}
          accessibilityLabel={t('driverDashboard.codeLabel')}
          value={code}
          onChangeText={(text) => {
            setCode(sanitizeDeliveryOtpInput(text));
          }}
          onSubmitEditing={submit}
          keyboardType="number-pad"
          inputMode="numeric"
          autoComplete="off"
          autoCorrect={false}
          maxLength={DELIVERY_OTP_LENGTH}
          editable={!submitting}
          placeholder={t('driverDashboard.codePlaceholder')}
          className="rounded-xl border border-neutral-300 bg-white px-3 py-3 text-center text-2xl tracking-[8px] text-neutral-900"
        />
        <Button
          label={submitting ? t('driverDashboard.checking') : t('driverDashboard.deliver')}
          disabled={!canSubmit}
          onPress={submit}
          testID={`deliver-${order.id}`}
        />
      </View>
    </View>
  );
}
