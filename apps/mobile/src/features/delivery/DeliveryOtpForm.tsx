import { DELIVERY_OTP_LENGTH } from '@hamro-pasal/shared-types';
import { useState } from 'react';
import { Text, TextInput, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { Button } from '../../components/Button';
import { isCompleteDeliveryOtp, sanitizeDeliveryOtpInput } from './delivery-otp-input';

export interface DeliveryOtpFormProps {
  orderId: string;
  /** This order's code is being checked by the server. */
  submitting: boolean;
  /** Sends the typed code; `onRejected` clears the field so it is typed afresh. */
  onSubmit: (otp: string, onRejected: () => void) => void;
}

/**
 * The doorstep handoff (customer journey 10): the customer's 4-digit code and "Confirm delivery".
 * Used by the platform rider and by the vendor's own staff (SELF_DELIVERY orders). Only ASCII
 * digits are kept (a Nepali keyboard's ०–९ converted); the button waits for 4 of them.
 */
export function DeliveryOtpForm({ orderId, submitting, onSubmit }: DeliveryOtpFormProps) {
  const { t } = useTranslation();
  const [code, setCode] = useState('');
  const canSubmit = isCompleteDeliveryOtp(code) && !submitting;

  const submit = (): void => {
    if (!canSubmit) return;
    onSubmit(code, () => {
      setCode('');
    });
  };

  return (
    <View className="gap-2">
      <Text className="text-sm font-medium text-neutral-700">{t('delivery.codeLabel')}</Text>
      <TextInput
        testID={`delivery-otp-${orderId}`}
        accessibilityLabel={t('delivery.codeLabel')}
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
        placeholder={t('delivery.codePlaceholder')}
        className="rounded-xl border border-neutral-300 bg-white px-3 py-3 text-center text-2xl tracking-[8px] text-neutral-900"
      />
      <Button
        label={submitting ? t('delivery.checking') : t('delivery.confirm')}
        disabled={!canSubmit}
        onPress={submit}
        testID={`deliver-${orderId}`}
      />
    </View>
  );
}
