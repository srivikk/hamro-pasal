import { act, waitFor } from '@testing-library/react-native';
import { http, HttpResponse } from 'msw';
import { AppState, Platform, type AppStateStatus } from 'react-native';

import { useAuthStore } from '../../store/useAuthStore';
import {
  getExpoPushTokenAsync,
  getPermissionsAsync,
  mockNotifications,
  requestPermissionsAsync,
  resetMockNotifications,
} from '../../test/fake-notifications';
import {
  apiUrl,
  capture,
  server,
  setupApiTestEnvironment,
  TEST_ACCESS_TOKEN,
  type CapturedRequest,
} from '../../test/msw';
import { renderHookWithProviders } from '../../test/render';
import { devicePlatform, easProjectId, registerForPushNotifications } from './push-registration';
import { usePushRegistration } from './usePushRegistration';

// jest-expo's expo-constants carries no app config: give it the real app.json, so the test covers
// the shape the token request reads (extra.eas.projectId).
jest.mock('expo-constants', () => {
  const appJson = jest.requireActual<{ expo: Record<string, unknown> }>('../../../app.json');
  return { __esModule: true, default: { expoConfig: appJson.expo } };
});

setupApiTestEnvironment();

const DEVICE_TOKEN_URL = apiUrl('/api/notifications/device-token');

/** Answers the registration endpoint like the API and records every request. */
function deviceTokenEndpoint(status: 200 | 503 = 200): CapturedRequest[] {
  const requests: CapturedRequest[] = [];
  server.use(
    http.post(DEVICE_TOKEN_URL, async ({ request }) => {
      const captured = await capture(request);
      requests.push(captured);
      if (status !== 200) {
        return HttpResponse.json(
          { error: { code: 'INTERNAL_SERVER_ERROR', message: 'down' } },
          { status },
        );
      }
      const body = captured.body as { token: string; platform: string };
      return HttpResponse.json({
        device_token: { ...body, updated_at: '2026-10-03T10:00:00.000Z' },
      });
    }),
  );
  return requests;
}

beforeEach(() => {
  resetMockNotifications();
  jest.replaceProperty(Platform, 'OS', 'android');
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('registerForPushNotifications', () => {
  it('asks for permission, fetches the Expo push token and sends it to the API', async () => {
    const requests = deviceTokenEndpoint();

    const result = await registerForPushNotifications();

    expect(result).toBe('registered');
    expect(requestPermissionsAsync).toHaveBeenCalledTimes(1);
    // The token is issued for this app's EAS project (app.json extra.eas.projectId).
    expect(getExpoPushTokenAsync).toHaveBeenCalledWith({
      projectId: 'f91dc398-deb8-4af4-9b50-0210e8cb080f',
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe('POST');
    expect(requests[0]?.headers.get('authorization')).toBe(`Bearer ${TEST_ACCESS_TOKEN}`);
    expect(requests[0]?.body).toEqual({
      token: 'ExponentPushToken[test-device]',
      platform: 'ANDROID',
    });
  });

  it('does not ask again when the permission is already granted', async () => {
    mockNotifications.permission = { granted: true, canAskAgain: true };
    const requests = deviceTokenEndpoint();

    expect(await registerForPushNotifications()).toBe('registered');

    expect(getPermissionsAsync).toHaveBeenCalledTimes(1);
    expect(requestPermissionsAsync).not.toHaveBeenCalled();
    expect(requests).toHaveLength(1);
  });

  it('sends IOS from an iPhone', async () => {
    jest.replaceProperty(Platform, 'OS', 'ios');
    const requests = deviceTokenEndpoint();

    await registerForPushNotifications();

    expect(requests[0]?.body).toMatchObject({ platform: 'IOS' });
  });

  it('registers nothing when the user refuses the prompt', async () => {
    mockNotifications.requested = { granted: false, canAskAgain: false };
    const requests = deviceTokenEndpoint();

    expect(await registerForPushNotifications()).toBe('permission_denied');

    expect(getExpoPushTokenAsync).not.toHaveBeenCalled();
    expect(requests).toEqual([]);
  });

  it('does not prompt when the OS no longer allows asking', async () => {
    mockNotifications.permission = { granted: false, canAskAgain: false };
    const requests = deviceTokenEndpoint();

    expect(await registerForPushNotifications()).toBe('permission_denied');

    expect(requestPermissionsAsync).not.toHaveBeenCalled();
    expect(requests).toEqual([]);
  });

  it('is unavailable when the device cannot get a token (emulator, simulator)', async () => {
    mockNotifications.pushToken = null;
    const requests = deviceTokenEndpoint();

    expect(await registerForPushNotifications()).toBe('unavailable');
    expect(requests).toEqual([]);
  });

  it('is unavailable on the web, without touching the permission', async () => {
    jest.replaceProperty(Platform, 'OS', 'web');

    expect(await registerForPushNotifications()).toBe('unavailable');
    expect(getPermissionsAsync).not.toHaveBeenCalled();
  });

  it('reports failed when the server cannot be told, so the caller retries', async () => {
    const requests = deviceTokenEndpoint(503);

    expect(await registerForPushNotifications()).toBe('failed');
    expect(requests).toHaveLength(1);
  });

  it('sends nothing for a token that is not an Expo push token', async () => {
    mockNotifications.pushToken = 'fcm:APA91bHun4MxP5egoKMwt2KZFBaFUH';
    const requests = deviceTokenEndpoint();

    expect(await registerForPushNotifications()).toBe('failed');
    expect(requests).toEqual([]);
  });
});

describe('devicePlatform and easProjectId', () => {
  it('maps the platform and reads the project id from the app config', () => {
    expect(devicePlatform('android')).toBe('ANDROID');
    expect(devicePlatform('ios')).toBe('IOS');
    expect(devicePlatform('web')).toBeNull();
    expect(easProjectId()).toBe('f91dc398-deb8-4af4-9b50-0210e8cb080f');
  });
});

describe('usePushRegistration', () => {
  /** Captures the hook's AppState listener so a test can bring the app to the foreground. */
  function appState() {
    let listener: ((state: AppStateStatus) => void) | undefined;
    const remove = jest.fn();
    jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, handler) => {
      listener = handler;
      return { remove };
    });
    return {
      remove,
      change: (state: AppStateStatus) => {
        act(() => {
          listener?.(state);
        });
      },
    };
  }

  it('registers at launch when a session exists', async () => {
    const requests = deviceTokenEndpoint();

    renderHookWithProviders(() => {
      usePushRegistration();
    });

    await waitFor(() => {
      expect(requests).toHaveLength(1);
    });
  });

  it('does not prompt or register while signed out, then registers right after sign-in', async () => {
    useAuthStore.getState().clearSession();
    const requests = deviceTokenEndpoint();
    renderHookWithProviders(() => {
      usePushRegistration();
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(getPermissionsAsync).not.toHaveBeenCalled();
    expect(requests).toEqual([]);

    act(() => {
      useAuthStore
        .getState()
        .setSession({ accessToken: TEST_ACCESS_TOKEN, refreshToken: 'refresh-token-1' });
    });

    await waitFor(() => {
      expect(requests).toHaveLength(1);
    });
    expect(requestPermissionsAsync).toHaveBeenCalledTimes(1);
  });

  it('registers again when another sign-in follows a sign-out', async () => {
    const requests = deviceTokenEndpoint();
    renderHookWithProviders(() => {
      usePushRegistration();
    });
    await waitFor(() => {
      expect(requests).toHaveLength(1);
    });

    act(() => {
      useAuthStore.getState().clearSession();
    });
    act(() => {
      useAuthStore
        .getState()
        .setSession({ accessToken: TEST_ACCESS_TOKEN, refreshToken: 'refresh-token-2' });
    });

    await waitFor(() => {
      expect(requests).toHaveLength(2);
    });
  });

  it('does not register again when only the access token is renewed', async () => {
    const requests = deviceTokenEndpoint();
    const state = appState();
    renderHookWithProviders(() => {
      usePushRegistration();
    });
    await waitFor(() => {
      expect(requests).toHaveLength(1);
    });

    act(() => {
      useAuthStore.getState().setAccessToken(`${TEST_ACCESS_TOKEN}2`);
    });
    state.change('active');
    await act(async () => {
      await Promise.resolve();
    });

    expect(requests).toHaveLength(1);
  });

  it('retries a failed registration when the app returns to the foreground', async () => {
    const failed = deviceTokenEndpoint(503);
    const state = appState();
    renderHookWithProviders(() => {
      usePushRegistration();
    });
    await waitFor(() => {
      expect(failed).toHaveLength(1);
    });
    // Let the failed attempt settle before the app comes back.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    const requests = deviceTokenEndpoint();
    state.change('background');
    state.change('active');

    await waitFor(() => {
      expect(requests).toHaveLength(1);
    });
  });

  it('stops listening when unmounted', () => {
    deviceTokenEndpoint();
    const state = appState();

    const { unmount } = renderHookWithProviders(() => {
      usePushRegistration();
    });
    unmount();

    expect(state.remove).toHaveBeenCalledTimes(1);
  });
});
