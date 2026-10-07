import { useTranslation } from 'react-i18next';

import { useUpdateAccount } from '../../api/account';
import { useAuthStore } from '../../store/useAuthStore';
import { selectSessionUserId, useProfileStore } from '../../store/useProfileStore';
import { useToastStore } from '../../store/useToastStore';
import { useCurrentConsents } from '../profile/profile-form';

/**
 * The account's "Get updates on WhatsApp" choice (`users.whatsapp_opt_in`), for any role. The
 * switch moves at once; if the server refuses or cannot be reached it moves back and says so.
 */
export function useWhatsAppOptIn(): {
  optedIn: boolean;
  pending: boolean;
  change: (next: boolean) => void;
} {
  const { t } = useTranslation();
  const userId = useAuthStore(selectSessionUserId);
  const optedIn = useCurrentConsents()?.whatsapp_opt_in ?? false;
  const updateAccount = useUpdateAccount();
  const showToast = useToastStore((state) => state.show);

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

  return { optedIn, pending: updateAccount.isPending, change };
}
