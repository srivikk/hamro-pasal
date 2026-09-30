import type { QueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';

import { onSessionExpired } from '../../api/http';
import { useToastStore } from '../../store/useToastStore';

/**
 * When a refresh token is refused (apiRequest has already signed the user out), drop every cached
 * response so nothing from that session stays on screen, and tell the user. Mounted once, at the root.
 */
export function useSessionExpiryHandler(queryClient: QueryClient): void {
  const { t } = useTranslation();

  useEffect(
    () =>
      onSessionExpired(() => {
        queryClient.clear();
        useToastStore.getState().show(t('auth.sessionExpired'), 'info');
      }),
    [queryClient, t],
  );
}
