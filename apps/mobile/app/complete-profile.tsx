import { Redirect, router, Stack } from 'expo-router';
import { useState } from 'react';
import { Text, TextInput, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { useUpdateAccount } from '../src/api/account';
import { Button } from '../src/components/Button';
import { Checkbox } from '../src/components/Checkbox';
import { KeyboardScreen } from '../src/components/KeyboardScreen';
import { leaveSignIn } from '../src/features/auth/login-form';
import {
  useCurrentConsents,
  useCurrentProfile,
  useOnboardingRequired,
  validateProfileForm,
  type ProfileField,
} from '../src/features/profile/profile-form';
import { selectHasSession, useAuthStore } from '../src/store/useAuthStore';
import {
  MAX_EMAIL_LENGTH,
  MAX_FULL_NAME_LENGTH,
  selectSessionUserId,
  useProfileStore,
} from '../src/store/useProfileStore';
import { useToastStore } from '../src/store/useToastStore';

/**
 * The customer's name (required), email (optional) and consents. Three uses of one screen:
 * - mandatory onboarding right after an OTP sign-in created the account (no way back);
 * - completing the profile later (an older account without a name);
 * - editing the details from the Profile tab.
 * The Terms box is shown, and required, until the account has accepted them; the WhatsApp box is
 * shown with it (afterwards that choice lives under Notification Preferences).
 */
export default function CompleteProfileScreen() {
  const { t } = useTranslation();
  const signedIn = useAuthStore(selectHasSession);
  const userId = useAuthStore(selectSessionUserId);
  const current = useCurrentProfile();
  const consents = useCurrentConsents();
  const mandatory = useOnboardingRequired();
  const updateAccount = useUpdateAccount();
  const showToast = useToastStore((state) => state.show);
  const [fullName, setFullName] = useState(current?.full_name ?? '');
  const [email, setEmail] = useState(current?.email ?? '');
  // Decided once, when the screen opens: the boxes do not vanish while the save is in flight.
  const [needsTerms] = useState(consents?.terms_accepted_at == null);
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [whatsAppOptIn, setWhatsAppOptIn] = useState(consents?.whatsapp_opt_in ?? false);
  const [errors, setErrors] = useState<Partial<Record<ProfileField | 'terms', true>>>({});

  if (!signedIn) return <Redirect href="/login" />;

  const save = (): void => {
    if (updateAccount.isPending) return;
    const result = validateProfileForm(fullName, email);
    const termsMissing = needsTerms && !termsAccepted;
    if (!result.ok || termsMissing) {
      setErrors({ ...(result.ok ? {} : result.errors), ...(termsMissing ? { terms: true } : {}) });
      return;
    }
    setErrors({});
    const { details } = result;
    updateAccount.mutate(
      {
        ...details,
        language_preference: useAuthStore.getState().locale,
        ...(needsTerms ? { accept_terms: true as const, whatsapp_opt_in: whatsAppOptIn } : {}),
      },
      {
        // `user` is null while the API has no profile route: the details are then kept on this
        // phone only, with the phone's clock for the consent.
        onSuccess: (user) => {
          const store = useProfileStore.getState();
          store.setProfile(details, userId);
          if (needsTerms) {
            store.setConsents(
              {
                terms_accepted_at: user?.terms_accepted_at ?? new Date().toISOString(),
                whatsapp_opt_in: user?.whatsapp_opt_in ?? whatsAppOptIn,
              },
              userId,
            );
          }
          store.completeOnboarding();
          showToast(t('profile.saved'), 'success');
          leaveSignIn(router);
        },
        onError: () => {
          showToast(t('profile.saveFailed'), 'error');
        },
      },
    );
  };

  // Ticking the box answers the complaint at once, without another press of Save.
  const termsError = errors.terms === true && !termsAccepted;
  const inputClass = 'rounded-xl border border-gray-300 bg-white px-3 py-3 text-base text-gray-900';
  const labelClass = 'text-sm font-semibold text-gray-800 dark:text-gray-200';

  return (
    <KeyboardScreen testID="complete-profile-screen">
      <Stack.Screen
        options={{
          headerShown: true,
          title: t('profile.title'),
          headerBackTitle: t('common.back'),
          // Onboarding is not skippable: no back arrow and no back swipe.
          headerBackVisible: !mandatory,
          gestureEnabled: !mandatory,
        }}
      />
      <Text className="text-2xl font-bold text-gray-900 dark:text-gray-100">
        {t('profile.title')}
      </Text>
      <Text className="text-base text-gray-700 dark:text-gray-300">{t('profile.subtitle')}</Text>

      <View className="gap-2">
        <Text className={labelClass}>{t('profile.fullName')}</Text>
        <TextInput
          testID="profile-full-name"
          accessibilityLabel={t('profile.fullName')}
          value={fullName}
          onChangeText={setFullName}
          maxLength={MAX_FULL_NAME_LENGTH}
          autoCapitalize="words"
          autoComplete="name"
          textContentType="name"
          className={inputClass}
        />
        {errors.full_name === true ? (
          <Text testID="profile-error-full_name" className="text-sm text-red-700">
            {t('profile.errors.full_name')}
          </Text>
        ) : null}
      </View>

      <View className="gap-2">
        <Text className={labelClass}>{t('profile.emailOptional')}</Text>
        <TextInput
          testID="profile-email"
          accessibilityLabel={t('profile.emailOptional')}
          value={email}
          onChangeText={setEmail}
          maxLength={MAX_EMAIL_LENGTH}
          keyboardType="email-address"
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="email"
          textContentType="emailAddress"
          onSubmitEditing={save}
          className={inputClass}
        />
        {errors.email === true ? (
          <Text testID="profile-error-email" className="text-sm text-red-700">
            {t('profile.errors.email')}
          </Text>
        ) : null}
      </View>

      {needsTerms ? (
        <View className="gap-4" testID="profile-consents">
          <View className="gap-1">
            <Checkbox
              checked={termsAccepted}
              invalid={termsError}
              accessibilityLabel={t('profile.termsLabel')}
              testID="profile-terms"
              onChange={setTermsAccepted}
            >
              <Text className="text-sm text-gray-800 dark:text-gray-200">
                {t('profile.termsPrefix')}
                <Text
                  accessibilityRole="link"
                  testID="profile-terms-link"
                  className="font-semibold text-brand underline"
                  onPress={() => {
                    router.push({ pathname: '/legal/[doc]', params: { doc: 'terms' } });
                  }}
                >
                  {t('legal.terms')}
                </Text>
                {t('profile.termsJoin')}
                <Text
                  accessibilityRole="link"
                  testID="profile-privacy-link"
                  className="font-semibold text-brand underline"
                  onPress={() => {
                    router.push({ pathname: '/legal/[doc]', params: { doc: 'privacy' } });
                  }}
                >
                  {t('legal.privacy')}
                </Text>
                {t('profile.termsSuffix')}
              </Text>
            </Checkbox>
            {termsError ? (
              <Text testID="profile-error-terms" className="pl-9 text-sm text-red-700">
                {t('profile.errors.terms')}
              </Text>
            ) : null}
          </View>
          <Checkbox
            checked={whatsAppOptIn}
            accessibilityLabel={t('profile.whatsappOptIn')}
            testID="profile-whatsapp"
            onChange={setWhatsAppOptIn}
          >
            <Text className="text-sm text-gray-800 dark:text-gray-200">
              {t('profile.whatsappOptIn')}
            </Text>
          </Checkbox>
        </View>
      ) : null}

      <Button
        label={updateAccount.isPending ? t('profile.saving') : t('profile.save')}
        disabled={updateAccount.isPending}
        testID="profile-save"
        onPress={save}
      />
    </KeyboardScreen>
  );
}
