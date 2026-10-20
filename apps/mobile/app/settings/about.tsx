import { router } from 'expo-router';
import { Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { MenuCard, MenuRow } from '../../src/components/MenuRow';
import { LogoPlaceholder } from '../../src/features/boot/SplashView';
import { APP_VERSION } from '../../src/features/settings/app-version';
import { SettingsPage } from '../../src/features/settings/SettingsPage';
import { MadeInNepal } from '../../src/ui';

/**
 * Profile → About Us. PLACEHOLDER copy (`about.body`): replace with the approved description.
 * The two legal documents are linked at the bottom.
 */
export default function AboutScreen() {
  const { t } = useTranslation();

  return (
    <SettingsPage title={t('about.title')} testID="about-screen">
      <View className="items-center gap-3 rounded-card-lg bg-white p-6 shadow-sm dark:bg-gray-900">
        <LogoPlaceholder size={96} />
        <Text className="font-display text-2xl text-brand">{t('common.appName')}</Text>
        <Text className="text-sm text-gray-500 dark:text-gray-400">
          {t('about.version', { version: APP_VERSION })}
        </Text>
        <Text className="text-center font-body text-base leading-6 text-gray-700 dark:text-gray-300">
          {t('about.body')}
        </Text>
        <MadeInNepal className="pt-2" />
      </View>

      {/* Pushes the legal links to the bottom of the page. */}
      <View className="flex-1" />

      <MenuCard>
        <MenuRow
          icon="shield-checkmark-outline"
          label={t('legal.privacy')}
          testID="about-privacy-policy"
          onPress={() => {
            router.push({ pathname: '/legal/[doc]', params: { doc: 'privacy' } });
          }}
        />
        <MenuRow
          icon="document-text-outline"
          label={t('legal.terms')}
          testID="about-terms"
          last
          onPress={() => {
            router.push({ pathname: '/legal/[doc]', params: { doc: 'terms' } });
          }}
        />
      </MenuCard>
    </SettingsPage>
  );
}
