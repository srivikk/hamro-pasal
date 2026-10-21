import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';

import { useAppBadge, useInboxRefreshOnPush } from '../inbox/useInboxSync';
import { ensureOrderNotificationChannel } from './notification-handler';
import { useOrderNotificationTaps } from './notification-taps';
import { usePushRegistration } from './usePushRegistration';

/**
 * Root-level push wiring (Phase 20): keeps the Android "orders" channel, and since 2026-10-21 the
 * "new order" alarm channel, named in the app language; registers the device's push token while
 * a session exists; opens an order's tracking when its notification is tapped; and keeps the
 * inbox, its unread count and the app icon's badge in step with arriving pushes. Renders nothing.
 */
export function PushNotifications() {
  const { t } = useTranslation();
  const channelName = t('notifications.orderChannel');
  const alarmName = t('notifications.alarmChannel');

  useEffect(() => {
    ensureOrderNotificationChannel(channelName, alarmName).catch(() => undefined);
  }, [channelName, alarmName]);
  usePushRegistration();
  useOrderNotificationTaps();
  useInboxRefreshOnPush();
  useAppBadge();

  return null;
}
