import type { NotificationListResponseBody } from '@hamro-pasal/shared-types';
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
} from '@tanstack/react-query';

import { retryTransientFailures } from '../../api/query-client';
import { selectHasSession, useAuthStore } from '../../store/useAuthStore';
import {
  fetchNotifications,
  fetchUnreadCount,
  markAllNotificationsRead,
  markNotificationRead,
} from './inbox-api';

export const INBOX_QUERY_KEY = ['me', 'notifications'] as const;
export const UNREAD_QUERY_KEY = ['me', 'notifications', 'unread'] as const;

/** The unread badge: refreshed when the screen it is on is shown, and every minute. */
export function useUnreadCount() {
  const signedIn = useAuthStore(selectHasSession);
  return useQuery({
    queryKey: UNREAD_QUERY_KEY,
    queryFn: fetchUnreadCount,
    enabled: signedIn,
    refetchInterval: 60_000,
    retry: retryTransientFailures,
  });
}

/** The notification centre, newest first, a page at a time. */
export function useInbox() {
  return useInfiniteQuery({
    queryKey: INBOX_QUERY_KEY,
    queryFn: ({ pageParam }) => fetchNotifications(pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.next_cursor ?? undefined,
    retry: retryTransientFailures,
  });
}

type InboxData = InfiniteData<NotificationListResponseBody, string | undefined>;

/** Marks one message read and shows it so at once; the badge follows. */
export function useMarkRead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: markNotificationRead,
    retry: false,
    onSuccess: (read) => {
      queryClient.setQueryData<InboxData>(INBOX_QUERY_KEY, (data) =>
        data === undefined
          ? data
          : {
              ...data,
              pages: data.pages.map((page) => ({
                ...page,
                notifications: page.notifications.map((n) => (n.id === read.id ? read : n)),
              })),
            },
      );
      void queryClient.invalidateQueries({ queryKey: UNREAD_QUERY_KEY });
    },
  });
}

export function useMarkAllRead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: markAllNotificationsRead,
    retry: false,
    onSuccess: () => {
      const now = new Date().toISOString();
      queryClient.setQueryData<InboxData>(INBOX_QUERY_KEY, (data) =>
        data === undefined
          ? data
          : {
              ...data,
              pages: data.pages.map((page) => ({
                ...page,
                notifications: page.notifications.map((n) => ({ ...n, read_at: n.read_at ?? now })),
              })),
            },
      );
      queryClient.setQueryData(UNREAD_QUERY_KEY, 0);
    },
  });
}
