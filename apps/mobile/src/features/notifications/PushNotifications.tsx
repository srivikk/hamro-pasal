import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';

import { ensureOrderNotificationChannel } from './notification-handler';
import { usePushRegistration } from './usePushRegistration';

/**
 * Root-level push wiring (Phase 20): keeps the Android "orders" channel named in the app language
 * and registers the device's push token while a session exists. Renders nothing.
 */
export function PushNotifications() {
  const { t } = useTranslation();
  const channelName = t('notifications.orderChannel');

  useEffect(() => {
    ensureOrderNotificationChannel(channelName).catch(() => undefined);
  }, [channelName]);
  usePushRegistration();

  return null;
}
