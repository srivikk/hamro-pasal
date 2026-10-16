import {
  notificationListResponseSchema,
  notificationReadAllResponseSchema,
  notificationReadResponseSchema,
  notificationUnreadCountResponseSchema,
  type NotificationListResponseBody,
  type NotificationView,
} from '@hamro-pasal/shared-types';

import { apiRequest } from '../../api/http';

/* Step 7.5 (SPEC core 11): the account's notification centre (GET /api/me/notifications, …). */

export const NOTIFICATIONS_PATH = '/api/me/notifications';
export const UNREAD_COUNT_PATH = `${NOTIFICATIONS_PATH}/unread-count`;
export const READ_ALL_PATH = `${NOTIFICATIONS_PATH}/read-all`;
export const readPath = (id: string): string => `${NOTIFICATIONS_PATH}/${id}/read`;

export function fetchNotifications(cursor?: string): Promise<NotificationListResponseBody> {
  return apiRequest({
    method: 'GET',
    path: NOTIFICATIONS_PATH,
    query: cursor === undefined ? {} : { cursor },
    schema: notificationListResponseSchema,
  });
}

export async function fetchUnreadCount(): Promise<number> {
  const body = await apiRequest({
    method: 'GET',
    path: UNREAD_COUNT_PATH,
    schema: notificationUnreadCountResponseSchema,
  });
  return body.unread;
}

export async function markNotificationRead(id: string): Promise<NotificationView> {
  const body = await apiRequest({
    method: 'POST',
    path: readPath(id),
    schema: notificationReadResponseSchema,
  });
  return body.notification;
}

export async function markAllNotificationsRead(): Promise<number> {
  const body = await apiRequest({
    method: 'POST',
    path: READ_ALL_PATH,
    schema: notificationReadAllResponseSchema,
  });
  return body.marked;
}

/**
 * The app path a message opens when tapped (`data.deep_link`, set by the Super Admin), or null.
 * Only an in-app path is followed: anything else (a web address) is ignored.
 */
export function deepLinkOf(notification: Pick<NotificationView, 'data'>): string | null {
  const link = notification.data.deep_link;
  return typeof link === 'string' && /^\/[A-Za-z0-9/_\-?=&.%]*$/.test(link) ? link : null;
}

/** "9+" style badge text: up to 99, then "99+". */
export function badgeText(unread: number): string | null {
  if (unread <= 0) return null;
  return unread > 99 ? '99+' : String(unread);
}
