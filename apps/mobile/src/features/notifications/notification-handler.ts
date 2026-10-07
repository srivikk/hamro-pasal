import { ORDER_PUSH_CHANNEL_ID } from '@hamro-pasal/shared-types';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

/** The part of an incoming notification the foreground decision reads. */
interface IncomingNotification {
  readonly request: {
    readonly content: { readonly title: string | null; readonly body: string | null };
  };
}

/**
 * What to do with a notification that arrives while the app is open: show it as a banner (and
 * keep it in the notification list) with its sound. A data-only push has nothing to show: the
 * background task posts its visible notification, which then comes through here.
 */
export function foregroundBehavior(
  notification: IncomingNotification,
): Notifications.NotificationBehavior {
  const { title, body } = notification.request.content;
  const visible = (title ?? '') !== '' || (body ?? '') !== '';
  return {
    shouldShowBanner: visible,
    shouldShowList: visible,
    shouldPlaySound: visible,
    shouldSetBadge: false,
  };
}

/**
 * Installs the foreground handler (without one, Expo shows nothing while the app is in use).
 * Call once, at startup.
 */
export function configureForegroundNotifications(): void {
  Notifications.setNotificationHandler({
    handleNotification: (notification) => Promise.resolve(foregroundBehavior(notification)),
  });
}

/**
 * Android posts every notification to a channel; the worker's pushes and the app's own name
 * `ORDER_PUSH_CHANNEL_ID`. High importance = a heads-up banner with sound. Idempotent; the name
 * follows the app language at the time of the call. No-op on iOS.
 *
 * No `sound` key on purpose: a channel without one uses the system default notification sound.
 * On Android any string there, 'default' included, is looked up as a bundled sound file and
 * logged as "Custom sound 'default' not found in native app".
 */
export async function ensureOrderNotificationChannel(name: string): Promise<void> {
  if (Platform.OS !== 'android') return;
  await Notifications.setNotificationChannelAsync(ORDER_PUSH_CHANNEL_ID, {
    name,
    importance: Notifications.AndroidImportance.HIGH,
  });
}
