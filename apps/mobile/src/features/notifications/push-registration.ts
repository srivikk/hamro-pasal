import type { DevicePlatform } from '@hamro-pasal/shared-types';
import Constants from 'expo-constants';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

import { registerDeviceToken } from '../../api/notifications';

/**
 * What became of one attempt to register this device for pushes:
 * - `registered`: the server has this device's Expo push token for the signed-in account;
 * - `permission_denied`: the user refused notifications (the OS decides whether to ask again);
 * - `unavailable`: this build or device cannot get a token (no EAS project id, an emulator
 *   without Play services, a simulator, the web);
 * - `failed`: the token exists but the server could not be told (offline, 5xx): worth retrying.
 */
export type PushRegistrationResult = 'registered' | 'permission_denied' | 'unavailable' | 'failed';

/** The API's name for this device's platform; null where pushes do not exist (web). */
export function devicePlatform(os: string = Platform.OS): DevicePlatform | null {
  if (os === 'android') return 'ANDROID';
  if (os === 'ios') return 'IOS';
  return null;
}

/** The EAS project the push token is issued for (app.json `extra.eas.projectId`). */
export function easProjectId(): string | null {
  const extra: unknown = Constants.expoConfig?.extra;
  const eas: unknown =
    typeof extra === 'object' && extra !== null ? Reflect.get(extra, 'eas') : null;
  const fromConfig: unknown =
    typeof eas === 'object' && eas !== null ? Reflect.get(eas, 'projectId') : null;
  if (typeof fromConfig === 'string' && fromConfig !== '') return fromConfig;
  return Constants.easConfig?.projectId ?? null;
}

/** Asks for the notification permission unless it is already granted or can no longer be asked. */
async function ensurePermission(): Promise<boolean> {
  const current = await Notifications.getPermissionsAsync();
  if (current.granted) return true;
  if (!current.canAskAgain) return false;
  return (await Notifications.requestPermissionsAsync()).granted;
}

/**
 * SPEC implicit requirement 1 (Phase 20): permission → Expo push token → POST
 * /api/notifications/device-token. Needs a session (the endpoint is authenticated). Never throws.
 */
export async function registerForPushNotifications(): Promise<PushRegistrationResult> {
  const platform = devicePlatform();
  const projectId = easProjectId();
  if (platform === null || projectId === null) return 'unavailable';

  let token: string;
  try {
    if (!(await ensurePermission())) return 'permission_denied';
    token = (await Notifications.getExpoPushTokenAsync({ projectId })).data;
  } catch {
    return 'unavailable';
  }
  try {
    await registerDeviceToken({ token, platform });
    return 'registered';
  } catch {
    return 'failed';
  }
}
