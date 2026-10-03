import { useEffect, useRef } from 'react';
import { AppState } from 'react-native';

import { selectHasSession, useAuthStore } from '../../store/useAuthStore';
import { registerForPushNotifications, type PushRegistrationResult } from './push-registration';

/**
 * Registers this device for pushes whenever a session exists: at launch with a stored session and
 * right after sign-in (the permission prompt appears then, not on a signed-out first launch).
 * A new sign-in registers again, so the device follows the account using it. An attempt that
 * could not reach the server is repeated when the app next comes to the foreground. Mounted once,
 * at the root.
 */
export function usePushRegistration(): void {
  const hasSession = useAuthStore(selectHasSession);
  // A different refresh token is a different sign-in (possibly another account).
  const refreshToken = useAuthStore((state) => state.refreshToken);
  const last = useRef<PushRegistrationResult | null>(null);
  const inFlight = useRef(false);

  useEffect(() => {
    if (!hasSession) {
      last.current = null;
      return;
    }
    let active = true;
    const attempt = (): void => {
      if (inFlight.current) return;
      inFlight.current = true;
      void registerForPushNotifications().then((result) => {
        inFlight.current = false;
        if (active) last.current = result;
      });
    };

    last.current = null;
    attempt();
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active' && last.current === 'failed') attempt();
    });
    return () => {
      active = false;
      subscription.remove();
    };
  }, [hasSession, refreshToken]);
}
