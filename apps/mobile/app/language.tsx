import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Button } from '../src/components/Button';
import { LogoPlaceholder } from '../src/features/boot/SplashView';
import type { AppLocale } from '../src/i18n/app-locale';
import { useAuthStore } from '../src/store/useAuthStore';
import { useOnboardingStore } from '../src/store/useOnboardingStore';
import { colors } from '../src/theme/colors';

/** Each language is offered in its own script, whatever the app is currently showing. */
const OPTIONS: readonly { locale: AppLocale; name: string; hint: string }[] = [
  { locale: 'en', name: 'English', hint: 'Continue in English' },
  { locale: 'ne', name: 'नेपाली', hint: 'नेपालीमा अगाडि बढ्नुहोस्' },
];

const CONTINUE_LABEL: Record<AppLocale, string> = { en: 'Continue', ne: 'अगाडि बढ्नुहोस्' };

/**
 * First launch only: English or Nepali. The choice is saved on the phone and the question is not
 * asked again (it can be changed later from the sign-in screens and the Profile tab).
 */
export default function LanguageScreen() {
  const setLocale = useAuthStore((state) => state.setLocale);
  const markLanguageChosen = useOnboardingStore((state) => state.markLanguageChosen);
  const [selected, setSelected] = useState<AppLocale>(() => useAuthStore.getState().locale);

  return (
    <SafeAreaView className="flex-1 bg-white dark:bg-gray-950" testID="language-screen">
      <View className="flex-1 justify-center gap-8 px-6">
        <View className="items-center gap-4">
          <LogoPlaceholder size={80} />
          <View className="items-center gap-1">
            <Text className="text-2xl font-bold text-gray-900 dark:text-gray-100">
              Choose your language
            </Text>
            <Text className="text-lg text-gray-700 dark:text-gray-300">आफ्नो भाषा छान्नुहोस्</Text>
          </View>
        </View>

        <View accessibilityRole="radiogroup" className="gap-3">
          {OPTIONS.map(({ locale, name, hint }) => {
            const active = locale === selected;
            return (
              <Pressable
                key={locale}
                accessibilityRole="radio"
                accessibilityLabel={name}
                accessibilityState={{ selected: active }}
                testID={`language-option-${locale}`}
                className={`flex-row items-center gap-3 rounded-2xl border-2 p-4 ${
                  active
                    ? 'border-brand bg-brand-light dark:bg-gray-900'
                    : 'border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900'
                }`}
                onPress={() => {
                  setSelected(locale);
                }}
              >
                <View className="flex-1">
                  <Text className="text-lg font-bold text-gray-900 dark:text-gray-100">{name}</Text>
                  <Text className="text-sm text-gray-500 dark:text-gray-400">{hint}</Text>
                </View>
                <Ionicons
                  name={active ? 'radio-button-on' : 'radio-button-off'}
                  size={22}
                  color={active ? colors.brand : colors.inactive}
                />
              </Pressable>
            );
          })}
        </View>

        <Button
          label={CONTINUE_LABEL[selected]}
          testID="language-continue"
          onPress={() => {
            setLocale(selected);
            markLanguageChosen();
            router.replace('/');
          }}
        />
      </View>
    </SafeAreaView>
  );
}
