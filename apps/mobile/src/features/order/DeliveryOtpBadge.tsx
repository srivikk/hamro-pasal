import Ionicons from '@expo/vector-icons/Ionicons';
import { Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import type { AppLocale } from '../../i18n/app-locale';
import { formatLocalizedNumber } from '../../i18n/format-number';

/**
 * Formats the code digit by digit, so leading zeros survive ("0427", never "427") and each digit
 * becomes Devanagari under `ne`.
 */
export function localizeOtpDigits(otp: string, locale: AppLocale): string[] {
  return (otp.match(/[0-9]/g) ?? []).map((digit) => formatLocalizedNumber(Number(digit), locale));
}

/** SPEC journey step 10: the customer shows this 4-digit code to the rider at handoff. */
export function DeliveryOtpBadge({ otp, locale }: { otp: string | null; locale: AppLocale }) {
  const { t } = useTranslation();

  return (
    <View className="gap-3 rounded-2xl bg-neutral-900 p-5" testID="delivery-otp">
      <View className="flex-row items-center gap-2">
        <Ionicons name="shield-checkmark" size={20} color="#FACC15" />
        <Text className="text-sm font-bold uppercase tracking-wider text-yellow-300">
          {t('order.otp.title')}
        </Text>
      </View>
      {otp === null ? (
        <Text className="text-sm text-neutral-200">{t('order.otp.unavailable')}</Text>
      ) : (
        <View
          className="flex-row justify-center gap-3"
          accessible
          // Read out one digit at a time, in the active language.
          accessibilityLabel={t('order.otp.a11y', {
            digits: localizeOtpDigits(otp, locale).join(' '),
          })}
        >
          {localizeOtpDigits(otp, locale).map((digit, index) => (
            <View
              // Positions are stable for a fixed-length code.
              key={index}
              className="h-16 w-14 items-center justify-center rounded-xl bg-white"
            >
              <Text className="text-4xl font-bold text-neutral-900" testID="delivery-otp-digit">
                {digit}
              </Text>
            </View>
          ))}
        </View>
      )}
      <Text className="text-center text-sm font-semibold text-white">{t('order.otp.note')}</Text>
    </View>
  );
}
