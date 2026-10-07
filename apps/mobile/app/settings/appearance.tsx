import Ionicons from '@expo/vector-icons/Ionicons';
import type { ComponentProps } from 'react';
import { Pressable, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { MenuCard } from '../../src/components/MenuRow';
import { SettingsPage } from '../../src/features/settings/SettingsPage';
import { useThemeStore, type AppTheme } from '../../src/store/useThemeStore';
import { colors } from '../../src/theme/colors';

const ICON: Record<AppTheme, ComponentProps<typeof Ionicons>['name']> = {
  light: 'sunny-outline',
  dark: 'moon-outline',
  system: 'phone-portrait-outline',
};

const OPTIONS: readonly AppTheme[] = ['light', 'dark', 'system'];

/**
 * Profile → Appearance: Light, Dark or System. The choice is saved on the phone and applied at
 * once to the whole app (src/theme/apply-theme.ts hands it to NativeWind).
 */
export default function AppearanceScreen() {
  const { t } = useTranslation();
  const theme = useThemeStore((state) => state.theme);
  const setTheme = useThemeStore((state) => state.setTheme);

  return (
    <SettingsPage title={t('appearance.title')} testID="appearance-screen">
      <MenuCard>
        <View accessibilityRole="radiogroup">
          {OPTIONS.map((option, index) => {
            const selected = option === theme;
            return (
              <Pressable
                key={option}
                accessibilityRole="radio"
                accessibilityLabel={t(`appearance.options.${option}`)}
                accessibilityState={{ selected }}
                testID={`theme-option-${option}`}
                className="flex-row items-center gap-3 px-4 active:bg-gray-100 dark:active:bg-gray-800"
                onPress={() => {
                  setTheme(option);
                }}
              >
                <View className="h-9 w-9 items-center justify-center rounded-full bg-gray-100 dark:bg-gray-800">
                  <Ionicons name={ICON[option]} size={18} color={colors.inactive} />
                </View>
                <View
                  className={`flex-1 flex-row items-center py-4 ${
                    index === OPTIONS.length - 1
                      ? ''
                      : 'border-b border-gray-100 dark:border-gray-800'
                  }`}
                >
                  <Text className="flex-1 text-base font-medium text-gray-900 dark:text-gray-100">
                    {t(`appearance.options.${option}`)}
                  </Text>
                  <Ionicons
                    name={selected ? 'radio-button-on' : 'radio-button-off'}
                    size={22}
                    color={selected ? colors.brand : colors.inactive}
                  />
                </View>
              </Pressable>
            );
          })}
        </View>
      </MenuCard>
      <Text className="px-1 text-sm text-gray-500 dark:text-gray-400">{t('appearance.hint')}</Text>
    </SettingsPage>
  );
}
