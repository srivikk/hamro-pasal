import { useLocalSearchParams } from 'expo-router';
import { Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { SettingsPage } from '../../src/features/settings/SettingsPage';

export type LegalDocument = 'privacy' | 'terms';

/**
 * The Privacy Policy and the Terms & Conditions, opened from About Us and from the consent box.
 * PLACEHOLDER: `legal.placeholder` stands where the approved legal text goes. Both stores require
 * the real documents (and a public URL for each) before submission.
 */
export default function LegalDocumentScreen() {
  const { t } = useTranslation();
  const { doc } = useLocalSearchParams<{ doc?: string }>();
  const document: LegalDocument = doc === 'terms' ? 'terms' : 'privacy';
  const title = t(document === 'terms' ? 'legal.terms' : 'legal.privacy');

  return (
    <SettingsPage title={title} testID={`legal-${document}`}>
      <View className="gap-3 rounded-2xl bg-white p-5 shadow-sm dark:bg-gray-900">
        <Text className="text-xl font-bold text-gray-900 dark:text-gray-100">{title}</Text>
        <Text className="text-base leading-6 text-gray-700 dark:text-gray-300">
          {t('legal.placeholder', { document: title })}
        </Text>
      </View>
    </SettingsPage>
  );
}
