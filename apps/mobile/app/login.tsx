import { Stack, useLocalSearchParams } from 'expo-router';
import { Text } from 'react-native';
import { useTranslation } from 'react-i18next';

import { KeyboardScreen } from '../src/components/KeyboardScreen';
import { PhoneSignInForm } from '../src/features/auth/PhoneSignInForm';
import { LanguageToggle } from '../src/features/settings/LanguageToggle';

/**
 * Step 1 of OTP sign-in (SPEC journey step 1: "Auth via OTP (+977 only)"), reached from the cart
 * and the Profile tab. Opened with `mode=signup` it is the registration screen: the same request,
 * worded for a new customer (the server creates the account when an unknown number verifies its
 * code). The first-launch version of this screen is app/welcome.tsx.
 */
export default function LoginScreen() {
  const { t } = useTranslation();
  const { mode } = useLocalSearchParams<{ mode?: string }>();
  const signUp = mode === 'signup';
  const title = signUp ? t('auth.signUpTitle') : t('auth.title');

  return (
    <KeyboardScreen testID="login-screen">
      <Stack.Screen
        options={{
          headerShown: true,
          title,
          headerBackTitle: t('common.back'),
          headerRight: () => <LanguageToggle />,
        }}
      />
      <Text className="text-2xl font-bold text-gray-900 dark:text-gray-100">{title}</Text>
      <Text className="text-base text-gray-700 dark:text-gray-300">
        {signUp ? t('auth.signUpSubtitle') : t('auth.subtitle')}
      </Text>

      <PhoneSignInForm submitLabel={t('auth.sendCode')} />
      {signUp ? null : (
        <Text
          className="text-center text-sm text-gray-500 dark:text-gray-400"
          testID="login-new-here"
        >
          {t('auth.newHere')}
        </Text>
      )}
    </KeyboardScreen>
  );
}
