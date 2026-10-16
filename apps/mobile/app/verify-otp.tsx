import Ionicons from '@expo/vector-icons/Ionicons';
import { NEPAL_PHONE_REGEX, OTP_RESEND_COOLDOWN_SECONDS } from '@hamro-pasal/shared-types';
import { Redirect, router, Stack, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import {
  AUTH_ERROR_CODES,
  isWhatsAppUnavailable,
  useSendOtp,
  useSendOtpViaWhatsApp,
  useVerifyOtp,
} from '../src/api/auth';
import type { ApiError } from '../src/api/http';
import { Button } from '../src/components/Button';
import { KeyboardScreen } from '../src/components/KeyboardScreen';
import {
  formatNepalPhone,
  isCompleteOtp,
  leaveSignIn,
  sanitizeOtpInput,
} from '../src/features/auth/login-form';
import { LanguageToggle } from '../src/features/settings/LanguageToggle';
import { formatCountdown, useNow } from '../src/lib/countdown';
import { signupTokenOf } from '../src/features/seller/seller-api';
import { useAuthStore } from '../src/store/useAuthStore';
import { useSellerSignupStore } from '../src/store/useSellerSignupStore';
import { useToastStore } from '../src/store/useToastStore';
import { colors } from '../src/theme/colors';

function secondsParam(value: string | undefined): number {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : OTP_RESEND_COOLDOWN_SECONDS;
}

/** Step 2 of OTP sign-in: the 6-digit code texted to `phone`. */
export default function VerifyOtpScreen() {
  const { t } = useTranslation();
  const { phone, resendAfter } = useLocalSearchParams<{ phone?: string; resendAfter?: string }>();
  const locale = useAuthStore((state) => state.locale);
  const toast = useToastStore((state) => state.show);
  const verifyOtp = useVerifyOtp();
  const sendOtp = useSendOtp();
  const sendWhatsApp = useSendOtpViaWhatsApp();
  const [code, setCode] = useState('');
  const [resendAt, setResendAt] = useState(() => Date.now() + secondsParam(resendAfter) * 1000);
  const now = useNow();

  if (phone === undefined || !NEPAL_PHONE_REGEX.test(phone)) {
    return <Redirect href="/login" />;
  }

  const verificationError = (error: ApiError): string => {
    switch (error.code) {
      case AUTH_ERROR_CODES.invalid: {
        const left = (error.details as { attempts_remaining?: unknown } | undefined)
          ?.attempts_remaining;
        return t('auth.wrongCode', { count: typeof left === 'number' ? left : 0 });
      }
      case AUTH_ERROR_CODES.expired:
        return t('auth.expired');
      case AUTH_ERROR_CODES.attemptsExceeded:
        return t('auth.tooManyAttempts');
      default:
        return t('auth.failed');
    }
  };

  const submit = (): void => {
    if (!isCompleteOtp(code) || verifyOtp.isPending) return;
    verifyOtp.mutate(
      { phone, code },
      {
        onSuccess: ({ is_new_user: isNewUser }) => {
          toast(t('auth.signedIn'), 'info');
          // A brand-new account completes its profile (name, consents) before anything else.
          if (isNewUser) router.replace('/complete-profile');
          else leaveSignIn(router);
        },
        onError: (error) => {
          setCode('');
          // Step 7.7: the Seller app signed in a number without a shop: sign it up.
          const signup = signupTokenOf(error);
          if (signup !== null) {
            useSellerSignupStore.getState().start(phone, signup.token, signup.expiresInSeconds);
            router.replace('/seller-signup');
          }
        },
      },
    );
  };

  const resend = (): void => {
    verifyOtp.reset();
    sendOtp.mutate(phone, {
      onSuccess: ({ resend_after_seconds: seconds }) => {
        setResendAt(Date.now() + seconds * 1000);
        toast(t('auth.resent'), 'info');
      },
      onError: (error) => {
        const retry = (error.details as { retry_after_seconds?: unknown } | undefined)
          ?.retry_after_seconds;
        if (typeof retry === 'number') setResendAt(Date.now() + retry * 1000);
        toast(
          error.code === AUTH_ERROR_CODES.smsFailed ? t('auth.smsFailed') : t('auth.failed'),
          'error',
        );
      },
    });
  };

  const resendViaWhatsApp = (): void => {
    verifyOtp.reset();
    sendWhatsApp.mutate(phone, {
      onSuccess: ({ resend_after_seconds: seconds }) => {
        setResendAt(Date.now() + seconds * 1000);
        toast(t('auth.whatsappSent'), 'info');
      },
      onError: (error) => {
        const retry = (error.details as { retry_after_seconds?: unknown } | undefined)
          ?.retry_after_seconds;
        if (typeof retry === 'number') setResendAt(Date.now() + retry * 1000);
        toast(
          isWhatsAppUnavailable(error) ? t('auth.whatsappUnavailable') : t('auth.failed'),
          'error',
        );
      },
    });
  };

  const resendInMs = Math.max(0, resendAt - now);
  const whatsAppDisabled = resendInMs > 0 || sendWhatsApp.isPending || sendOtp.isPending;
  const message = verifyOtp.error === null ? null : verificationError(verifyOtp.error);

  return (
    <KeyboardScreen testID="verify-otp-screen">
      <Stack.Screen
        options={{
          headerShown: true,
          title: t('auth.verifyTitle'),
          headerBackTitle: t('common.back'),
          headerRight: () => <LanguageToggle />,
        }}
      />
      <Text className="text-2xl font-bold text-gray-900 dark:text-gray-100">
        {t('auth.verifyTitle')}
      </Text>
      <Text className="text-base text-gray-700 dark:text-gray-300">
        {t('auth.sentTo', { phone: formatNepalPhone(phone) })}
      </Text>

      <View className="gap-2">
        <Text className="text-sm font-semibold text-gray-800 dark:text-gray-200">
          {t('auth.codeLabel')}
        </Text>
        <TextInput
          testID="otp-input"
          accessibilityLabel={t('auth.codeLabel')}
          value={code}
          onChangeText={(text) => {
            setCode(sanitizeOtpInput(text));
            verifyOtp.reset();
          }}
          onSubmitEditing={submit}
          keyboardType="number-pad"
          textContentType="oneTimeCode"
          autoComplete="sms-otp"
          autoFocus
          maxLength={6}
          className="rounded-xl border border-gray-300 bg-white px-3 py-3 text-center text-2xl tracking-[8px] text-gray-900"
        />
        {message === null ? null : (
          <Text testID="otp-error" className="text-sm text-red-700">
            {message}
          </Text>
        )}
      </View>

      <Button
        label={verifyOtp.isPending ? t('auth.verifying') : t('auth.verify')}
        disabled={!isCompleteOtp(code) || verifyOtp.isPending}
        onPress={submit}
      />

      {resendInMs > 0 ? (
        <Text testID="resend-countdown" className="text-center text-sm text-gray-500">
          {t('auth.resendIn', { time: formatCountdown(resendInMs, locale) })}
        </Text>
      ) : (
        <Button
          label={t('auth.resend')}
          variant="secondary"
          disabled={sendOtp.isPending}
          onPress={resend}
        />
      )}
      {/* SMS not arriving: the same code request through the server's WhatsApp provider. The
          per-number resend cooldown applies to it too. */}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t('auth.whatsapp')}
        accessibilityState={{ disabled: whatsAppDisabled }}
        disabled={whatsAppDisabled}
        testID="otp-whatsapp"
        className={`flex-row items-center justify-center gap-2 py-2 ${whatsAppDisabled ? 'opacity-40' : ''}`}
        onPress={resendViaWhatsApp}
      >
        <Ionicons name="logo-whatsapp" size={20} color={colors.success} />
        <Text className="text-base font-semibold text-emerald-700">{t('auth.whatsapp')}</Text>
      </Pressable>
      <Button
        label={t('auth.changeNumber')}
        variant="secondary"
        onPress={() => {
          router.replace('/login');
        }}
      />
    </KeyboardScreen>
  );
}
