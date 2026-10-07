import { Redirect, router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ImageBackground, KeyboardAvoidingView, Platform, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { SafeAreaView } from 'react-native-safe-area-context';

import authWallPlaceholder from '../assets/images/auth-wall-placeholder.png';
import { Button } from '../src/components/Button';
import { PhoneSignInForm } from '../src/features/auth/PhoneSignInForm';
import { LogoPlaceholder } from '../src/features/boot/SplashView';
import { LocationSelectorModal } from '../src/features/location/LocationHeader';
import { LanguageToggle } from '../src/features/settings/LanguageToggle';
import { selectHasSession, useAuthStore } from '../src/store/useAuthStore';
import { useBrowseLocationStore } from '../src/store/useBrowseLocationStore';
import { useOnboardingStore } from '../src/store/useOnboardingStore';

/**
 * The first screen after boot for a visitor who is not signed in: sign in or sign up with a +977
 * number (the same OTP flow as /login), or "Skip login" to browse as a guest. The customer tabs
 * send such a visitor here until they do one or the other.
 *
 * PLACEHOLDER artwork: the background is a plain gradient standing in for the sketch of a
 * Nepal-themed shop (assets/images/auth-wall-placeholder.png; replace the file, keep the name).
 */
export default function WelcomeScreen() {
  const { t } = useTranslation();
  const signedIn = useAuthStore(selectHasSession);
  const skipAuthWall = useOnboardingStore((state) => state.skipAuthWall);
  const deviceChecked = useBrowseLocationStore((state) => state.deviceChecked);
  const deviceKnown = useBrowseLocationStore((state) => state.device !== null);
  const locationPrompt = useBrowseLocationStore((state) => state.locationPrompt);
  const requestLocationPrompt = useBrowseLocationStore((state) => state.requestLocationPrompt);
  const [selectorOpen, setSelectorOpen] = useState(false);
  const fallbackOffered = useRef(false);

  // Permission sequence: once the splash is gone and this screen is what the visitor sees, ask
  // for the device location (the OS dialog appears over this screen). Not when the position is
  // already known (the permission was granted on an earlier launch).
  useEffect(() => {
    if (!signedIn && deviceChecked && !deviceKnown) requestLocationPrompt();
  }, [signedIn, deviceChecked, deviceKnown, requestLocationPrompt]);

  // "Don't allow" (or no fix): show "Select delivery location" at once, with its
  // "Device location not enabled" banner. Once: dismissing it returns to this screen.
  useEffect(() => {
    if (signedIn || locationPrompt !== 'answered' || deviceKnown || fallbackOffered.current) return;
    fallbackOffered.current = true;
    setSelectorOpen(true);
  }, [signedIn, locationPrompt, deviceKnown]);

  // Signed in meanwhile (the code screen leaves through here when there is nothing to go back to).
  if (signedIn) return <Redirect href="/" />;

  return (
    <ImageBackground
      source={authWallPlaceholder}
      resizeMode="cover"
      className="flex-1"
      testID="auth-wall"
    >
      <SafeAreaView className="flex-1">
        <View className="flex-row items-center justify-between px-4 pt-2">
          <LanguageToggle />
          <Button
            label={t('welcome.skip')}
            size="sm"
            variant="secondary"
            testID="skip-login"
            onPress={() => {
              skipAuthWall();
              router.replace('/');
            }}
          />
        </View>
        <KeyboardAvoidingView
          className="flex-1 justify-end"
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        >
          <View className="items-center pb-6">
            <LogoPlaceholder size={96} />
          </View>
          <View className="gap-4 rounded-t-3xl bg-white p-6 dark:bg-gray-900">
            <Text className="text-2xl font-bold text-gray-900 dark:text-gray-100">
              {t('welcome.title')}
            </Text>
            <Text className="text-base text-gray-700 dark:text-gray-300">
              {t('welcome.subtitle')}
            </Text>
            <PhoneSignInForm submitLabel={t('welcome.continue')} />
          </View>
        </KeyboardAvoidingView>
      </SafeAreaView>
      <LocationSelectorModal
        visible={selectorOpen}
        onClose={() => {
          setSelectorOpen(false);
        }}
        // A location chosen here starts the guest visit: on to Home, which shows it in its header.
        onChosen={() => {
          skipAuthWall();
          router.replace('/');
        }}
      />
    </ImageBackground>
  );
}
