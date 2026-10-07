import { useQueryClient } from '@tanstack/react-query';
import { Redirect, router } from 'expo-router';
import { Alert, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import {
  ACCOUNT_HAS_PENDING_ORDERS,
  useDeletionEligibility,
  useRequestAccountDeletion,
} from '../../src/api/account';
import { Button } from '../../src/components/Button';
import { clearAccountData } from '../../src/features/account/clear-account-data';
import { SettingsPage } from '../../src/features/settings/SettingsPage';
import { selectHasSession, useAuthStore } from '../../src/store/useAuthStore';
import { useToastStore } from '../../src/store/useToastStore';

/**
 * Profile → Account Privacy: the customer asks for their account to be deleted (required by both
 * app stores). A soft delete: the server marks the account DELETED_REQUESTED; this phone then
 * signs out and forgets the account's data.
 *
 * 1. Ask the server whether deletion is possible now (no open orders).
 * 2. Not possible: say why. Possible: confirm once (native alert).
 * 3. Send the request. The server checks the open orders again.
 */
export default function AccountPrivacyScreen() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const signedIn = useAuthStore(selectHasSession);
  const eligibility = useDeletionEligibility();
  const deletion = useRequestAccountDeletion();
  const showToast = useToastStore((state) => state.show);
  const busy = eligibility.isPending || deletion.isPending;

  if (!signedIn) return <Redirect href="/" />;

  const pendingOrdersAlert = (): void => {
    Alert.alert(t('accountPrivacy.pendingTitle'), t('accountPrivacy.pendingBody'));
  };

  const submit = (): void => {
    deletion.mutate(undefined, {
      onSuccess: () => {
        clearAccountData(queryClient);
        showToast(t('accountPrivacy.requested'), 'success');
        router.replace('/');
      },
      onError: (error) => {
        // An order was placed between the check and the request.
        if (error.code === ACCOUNT_HAS_PENDING_ORDERS) pendingOrdersAlert();
        else showToast(t('accountPrivacy.failed'), 'error');
      },
    });
  };

  const start = (): void => {
    if (busy) return;
    eligibility.mutate(undefined, {
      onSuccess: ({ eligible }) => {
        if (!eligible) {
          pendingOrdersAlert();
          return;
        }
        Alert.alert(t('accountPrivacy.confirmTitle'), t('accountPrivacy.confirmBody'), [
          { text: t('accountPrivacy.cancel'), style: 'cancel' },
          { text: t('accountPrivacy.confirm'), style: 'destructive', onPress: submit },
        ]);
      },
      onError: () => {
        showToast(t('accountPrivacy.failed'), 'error');
      },
    });
  };

  return (
    <SettingsPage title={t('accountPrivacy.title')} testID="account-privacy-screen">
      <View className="gap-3 rounded-2xl bg-white p-5 shadow-sm dark:bg-gray-900">
        <Text className="text-lg font-bold text-gray-900 dark:text-gray-100">
          {t('accountPrivacy.heading')}
        </Text>
        <Text className="text-base leading-6 text-gray-700 dark:text-gray-300">
          {t('accountPrivacy.body')}
        </Text>
        <Text className="text-sm leading-5 text-gray-500 dark:text-gray-400">
          {t('accountPrivacy.retained')}
        </Text>
      </View>

      <Button
        label={busy ? t('accountPrivacy.working') : t('accountPrivacy.delete')}
        variant="destructive"
        disabled={busy}
        testID="delete-account"
        onPress={start}
      />
    </SettingsPage>
  );
}
