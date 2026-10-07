import { router } from 'expo-router';
import { useState } from 'react';
import { Text, TextInput, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { AUTH_ERROR_CODES, useSendOtp } from '../../api/auth';
import type { ApiError } from '../../api/http';
import { Button } from '../../components/Button';
import {
  NEPAL_DIALING_PREFIX,
  nextPhoneDraft,
  phoneInputMaxLength,
  toTenDigitNepalPhone,
} from './login-form';

/**
 * Step 1 of OTP sign-in (SPEC journey: "Auth via OTP (+977 only)"): the +977 number field and the
 * button that texts the code. Shared by the welcome screen and /login. On success the screen is
 * replaced by the code screen, so after verifying, one step back is whoever asked for sign-in.
 */
export function PhoneSignInForm({ submitLabel }: { submitLabel: string }) {
  const { t } = useTranslation();
  const sendOtp = useSendOtp();
  const [draft, setDraft] = useState('');
  const [touched, setTouched] = useState(false);
  // Exactly ten digits, and a Nepal mobile number, or nothing is sent.
  const phone = toTenDigitNepalPhone(draft);

  const errorMessage = (error: ApiError): string => {
    if (error.code === AUTH_ERROR_CODES.resendCooldown) {
      const seconds = (error.details as { retry_after_seconds?: unknown } | undefined)
        ?.retry_after_seconds;
      return t('auth.cooldown', { seconds: typeof seconds === 'number' ? seconds : 60 });
    }
    if (error.code === AUTH_ERROR_CODES.smsFailed) return t('auth.smsFailed');
    return t('auth.failed');
  };

  const submit = (): void => {
    setTouched(true);
    if (phone === null) return;
    sendOtp.mutate(phone, {
      onSuccess: ({ phone: sentTo, resend_after_seconds: resendAfter }) => {
        router.replace({
          pathname: '/verify-otp',
          params: { phone: sentTo, resendAfter: String(resendAfter) },
        });
      },
    });
  };

  const message =
    touched && phone === null
      ? t('auth.invalidPhone')
      : sendOtp.error === null
        ? null
        : errorMessage(sendOtp.error);

  return (
    <View className="gap-4">
      <View className="gap-2">
        <Text className="text-sm font-semibold text-gray-800 dark:text-gray-200">
          {t('auth.phoneLabel')}
        </Text>
        <View className="flex-row items-center rounded-xl border border-gray-300 bg-white px-3">
          <Text className="pr-2 text-base text-gray-700">{NEPAL_DIALING_PREFIX}</Text>
          <TextInput
            testID="phone-input"
            accessibilityLabel={t('auth.phoneLabel')}
            value={draft}
            onChangeText={(text) => {
              // A refused keystroke (an eleventh digit, a letter) changes no state at all.
              const next = nextPhoneDraft(draft, text);
              if (next === null) return;
              setDraft(next);
              sendOtp.reset();
            }}
            onBlur={() => {
              if (draft !== '') setTouched(true);
            }}
            onSubmitEditing={submit}
            placeholder={t('auth.phonePlaceholder')}
            keyboardType="number-pad"
            textContentType="telephoneNumber"
            autoComplete="tel"
            // Ten once the field is full (the keyboard refuses the eleventh digit natively, so it
            // never flashes); more while it is not, so a pasted "+977 98…" is not cut short.
            maxLength={phoneInputMaxLength(draft)}
            className="flex-1 py-3 text-base text-gray-900"
          />
        </View>
        {message === null ? null : (
          <Text testID="login-error" className="text-sm text-red-700">
            {message}
          </Text>
        )}
      </View>

      <Button
        label={sendOtp.isPending ? t('auth.sending') : submitLabel}
        disabled={sendOtp.isPending || draft.trim() === ''}
        onPress={submit}
      />
    </View>
  );
}
