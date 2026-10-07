import { router } from 'expo-router';
import { Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { useSignOut } from '../../api/auth';
import { Button } from '../../components/Button';

/**
 * TESTING ONLY (Phase 21): the way into Rider Mode from the Profile tab. A rider is a real account
 * role (the API authorises every call by it), so the toggle ends the current session and opens
 * sign-in; signing in with a rider's number lands on the rider dashboard, where "Sign out"
 * switches Rider Mode off again.
 */
export function RiderModeEntry() {
  const { t } = useTranslation();
  const signOut = useSignOut();

  return (
    <View
      className="gap-3 rounded-2xl border border-dashed border-gray-300 p-4"
      testID="rider-mode-entry"
    >
      <Text className="text-base font-bold text-gray-900">{t('riderMode.title')}</Text>
      <Text className="text-xs text-gray-500">{t('riderMode.hint')}</Text>
      <Button
        testID="rider-mode-toggle"
        label={t('riderMode.switch')}
        variant="secondary"
        onPress={() => {
          signOut();
          router.push('/login');
        }}
      />
    </View>
  );
}
