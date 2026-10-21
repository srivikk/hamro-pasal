import { useQueryClient } from '@tanstack/react-query';
import * as Notifications from 'expo-notifications';
import { useEffect } from 'react';

import { selectHasSession, useAuthStore } from '../../store/useAuthStore';
import { INBOX_QUERY_KEY, UNREAD_QUERY_KEY, useUnreadCount } from './useInbox';

/*
 * 2026-10-21 (Task 4): the notification centre follows the pushes. Every order alert is also kept
 * in the inbox (the worker's OrderInbox), so a push arriving means the inbox and its unread count
 * changed.
 */

/** The number the app icon shows: the unread count while signed in, nothing otherwise. */
export function appBadgeCount(signedIn: boolean, unread: number | undefined): number {
  return signedIn ? Math.max(0, unread ?? 0) : 0;
}

/** Keeps the app icon's badge equal to the unread count (iOS, and Android launchers that show one). */
export function useAppBadge(): void {
  const signedIn = useAuthStore(selectHasSession);
  const unread = useUnreadCount();
  const count = appBadgeCount(signedIn, unread.data);
  useEffect(() => {
    // A launcher without badges refuses; nothing else depends on it.
    Notifications.setBadgeCountAsync(count).catch(() => undefined);
  }, [count]);
}

/** Refetches the inbox and its unread count the moment a push arrives while the app is open. */
export function useInboxRefreshOnPush(): void {
  const queryClient = useQueryClient();
  useEffect(() => {
    const subscription = Notifications.addNotificationReceivedListener(() => {
      void queryClient.invalidateQueries({ queryKey: UNREAD_QUERY_KEY });
      void queryClient.invalidateQueries({ queryKey: INBOX_QUERY_KEY });
    });
    return () => {
      subscription.remove();
    };
  }, [queryClient]);
}
