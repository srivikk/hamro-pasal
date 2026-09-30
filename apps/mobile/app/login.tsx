import { router, Stack } from 'expo-router';
import { useState } from 'react';
import { ScrollView, Text, TextInput, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { AUTH_ERROR_CODES, useSendOtp } from '../src/api/auth';
import type { ApiError } from '../src/api/http';
import { Button } from '../src/components/Button';
import { NEPAL_DIALING_PREFIX, toNepalPhone } from '../src/features/auth/login-form';

/** Step 1 of OTP sign-in (SPEC journey step 1: "Auth via OTP (+977 only)"). */
export default function LoginScreen() {
  const { t } = useTranslation();
  const sendOtp = useSendOtp();
  const [draft, setDraft] = useState('');
  const [touched, setTouched] = useState(false);
  const phone = toNepalPhone(draft);

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
        // Replace, not push: after verifying, one step back is the screen that asked for sign-in.
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
    <ScrollView
      className="flex-1 bg-neutral-50"
      contentContainerStyle={{ padding: 24, gap: 16 }}
      keyboardShouldPersistTaps="handled"
    >
      <Stack.Screen
        options={{ headerShown: true, title: t('auth.title'), headerBackTitle: t('common.back') }}
      />
      <Text className="text-2xl font-bold text-neutral-900">{t('auth.title')}</Text>
      <Text className="text-base text-neutral-700">{t('auth.subtitle')}</Text>

      <View className="gap-2">
        <Text className="text-sm font-semibold text-neutral-800">{t('auth.phoneLabel')}</Text>
        <View className="flex-row items-center rounded-xl border border-neutral-300 bg-white px-3">
          <Text className="pr-2 text-base text-neutral-700">{NEPAL_DIALING_PREFIX}</Text>
          <TextInput
            testID="phone-input"
            accessibilityLabel={t('auth.phoneLabel')}
            value={draft}
            onChangeText={(text) => {
              setDraft(text);
              sendOtp.reset();
            }}
            onBlur={() => {
              if (draft !== '') setTouched(true);
            }}
            onSubmitEditing={submit}
            placeholder={t('auth.phonePlaceholder')}
            keyboardType="phone-pad"
            textContentType="telephoneNumber"
            autoComplete="tel"
            maxLength={16}
            className="flex-1 py-3 text-base text-neutral-900"
          />
        </View>
        {message === null ? null : (
          <Text testID="login-error" className="text-sm text-red-700">
            {message}
          </Text>
        )}
      </View>

      <Button
        label={sendOtp.isPending ? t('auth.sending') : t('auth.sendCode')}
        disabled={sendOtp.isPending || draft.trim() === ''}
        onPress={submit}
      />
    </ScrollView>
  );
}
