import { Stack } from 'expo-router';
import type { ReactNode } from 'react';
import { ScrollView } from 'react-native';
import { useTranslation } from 'react-i18next';

/** The frame of every page under the Profile tab: a titled stack header over a scrolling body. */
export function SettingsPage({
  title,
  testID,
  children,
}: {
  title: string;
  testID: string;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <ScrollView
      testID={testID}
      className="flex-1 bg-gray-50 dark:bg-gray-950"
      contentContainerStyle={{ padding: 16, gap: 16, flexGrow: 1 }}
    >
      <Stack.Screen options={{ headerShown: true, title, headerBackTitle: t('common.back') }} />
      {children}
    </ScrollView>
  );
}
