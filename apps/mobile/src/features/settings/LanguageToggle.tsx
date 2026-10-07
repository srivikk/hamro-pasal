import { Pressable, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { syncLanguagePreference } from '../../api/account';
import { APP_LOCALES, type AppLocale } from '../../i18n/app-locale';
import { selectHasSession, useAuthStore } from '../../store/useAuthStore';

/** Short labels for the two-segment switch. */
const SHORT_LABEL: Record<AppLocale, string> = { en: 'EN', ne: 'ने' };

/**
 * Changes the app language: saved on this phone at once and, for a signed-in account, copied to
 * the server in the background.
 */
export function useSetLanguage(): (locale: AppLocale) => void {
  return (locale) => {
    const auth = useAuthStore.getState();
    if (auth.locale === locale) return;
    auth.setLocale(locale);
    if (selectHasSession(auth)) void syncLanguagePreference(locale);
  };
}

/** A small EN / ने switch for a screen header (the sign-in screens). */
export function LanguageToggle() {
  const { t } = useTranslation();
  const locale = useAuthStore((state) => state.locale);
  const setLanguage = useSetLanguage();

  return (
    <View
      testID="language-toggle"
      className="flex-row overflow-hidden rounded-full border border-gray-300 bg-white dark:border-gray-700 dark:bg-gray-900"
    >
      {APP_LOCALES.map((option) => {
        const selected = option === locale;
        return (
          <Pressable
            key={option}
            accessibilityRole="button"
            accessibilityLabel={t(option === 'en' ? 'settings.english' : 'settings.nepali')}
            accessibilityState={{ selected }}
            testID={`language-toggle-${option}`}
            hitSlop={4}
            className={`px-3 py-1.5 ${selected ? 'bg-brand' : ''}`}
            onPress={() => {
              setLanguage(option);
            }}
          >
            <Text
              className={`text-xs font-bold ${
                selected ? 'text-white' : 'text-gray-700 dark:text-gray-300'
              }`}
            >
              {SHORT_LABEL[option]}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}
