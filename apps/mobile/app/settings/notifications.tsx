import Ionicons from '@expo/vector-icons/Ionicons';
import { Redirect } from 'expo-router';
import { Switch, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { useUpdateAccount } from '../../src/api/account';
import { MenuCard } from '../../src/components/MenuRow';
import { useCurrentConsents } from '../../src/features/profile/profile-form';
import { SettingsPage } from '../../src/features/settings/SettingsPage';
import { selectHasSession, useAuthStore } from '../../src/store/useAuthStore';
import { selectSessionUserId, useProfileStore } from '../../src/store/useProfileStore';
import { useToastStore } from '../../src/store/useToastStore';
import { colors } from '../../src/theme/colors';

/**
 * Profile → Notification Preferences: the account's "Get updates on WhatsApp" choice
 * (`users.whatsapp_opt_in`). The switch moves at once; if the server refuses or cannot be
 * reached it moves back and says so.
 */
export default function NotificationPreferencesScreen() {
  const { t } = useTranslation();
  const signedIn = useAuthStore(selectHasSession);
  const userId = useAuthStore(selectSessionUserId);
  const optedIn = useCurrentConsents()?.whatsapp_opt_in ?? false;
  const updateAccount = useUpdateAccount();
  const showToast = useToastStore((state) => state.show);

  if (!signedIn) return <Redirect href="/login" />;

  const change = (next: boolean): void => {
    if (updateAccount.isPending) return;
    const { setWhatsAppOptIn } = useProfileStore.getState();
    setWhatsAppOptIn(next, userId);
    updateAccount.mutate(
      { whatsapp_opt_in: next },
      {
        onSuccess: (user) => {
          // The server's answer wins (null: no such route yet, the phone's copy stands).
          if (user !== null) setWhatsAppOptIn(user.whatsapp_opt_in, userId);
        },
        onError: () => {
          setWhatsAppOptIn(!next, userId);
          showToast(t('notificationPrefs.failed'), 'error');
        },
      },
    );
  };

  return (
    <SettingsPage title={t('notificationPrefs.title')} testID="notification-prefs-screen">
      <MenuCard>
        <View className="flex-row items-center gap-3 p-4">
          <View className="h-9 w-9 items-center justify-center rounded-full bg-gray-100 dark:bg-gray-800">
            <Ionicons name="logo-whatsapp" size={18} color={colors.success} />
          </View>
          <View className="flex-1">
            <Text className="text-base font-medium text-gray-900 dark:text-gray-100">
              {t('notificationPrefs.whatsapp')}
            </Text>
            <Text className="mt-0.5 text-sm text-gray-500 dark:text-gray-400">
              {t('notificationPrefs.whatsappHint')}
            </Text>
          </View>
          <Switch
            testID="whatsapp-opt-in-switch"
            accessibilityLabel={t('notificationPrefs.whatsapp')}
            value={optedIn}
            disabled={updateAccount.isPending}
            onValueChange={change}
            trackColor={{ true: colors.brand }}
          />
        </View>
      </MenuCard>
      <Text className="px-1 text-sm text-gray-500 dark:text-gray-400">
        {t('notificationPrefs.orderNote')}
      </Text>
    </SettingsPage>
  );
}
