import { paymentMethods, type PaymentMethod } from '@hamro-pasal/shared-types';
import { Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { Button } from '../../components/Button';

export interface PaymentMethodPickerProps {
  value: PaymentMethod;
  onChange: (method: PaymentMethod) => void;
  disabled?: boolean;
}

/**
 * eSewa, Khalti or cash on delivery. COD eligibility (SPEC step 7: rating >= 3.0) is decided by
 * the server, which answers 422 COD_NOT_AVAILABLE when it is not allowed.
 */
export function PaymentMethodPicker({
  value,
  onChange,
  disabled = false,
}: PaymentMethodPickerProps) {
  const { t } = useTranslation();
  return (
    <View className="gap-2">
      <Text className="text-sm font-semibold text-neutral-700">{t('cart.paymentMethod')}</Text>
      <View className="flex-row gap-2" accessibilityRole="radiogroup">
        {paymentMethods.map((method) => (
          <View key={method} className="flex-1">
            <Button
              label={t(`payment.${method}`)}
              size="sm"
              variant={value === method ? 'primary' : 'secondary'}
              disabled={disabled}
              testID={`payment-method-${method}`}
              onPress={() => {
                onChange(method);
              }}
            />
          </View>
        ))}
      </View>
    </View>
  );
}
