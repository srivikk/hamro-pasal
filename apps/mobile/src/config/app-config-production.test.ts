import type { ExpoConfig } from 'expo/config';

import appConfig, { assertStoreBuildEnv } from '../../app.config';
import { APP_VERSION } from '../features/settings/app-version';

/*
 * Phase 7 (2026-10-22): what the store builds of both apps are made with (app.config.ts, eas.json).
 */

const KEYS = ['APP_VARIANT', 'EAS_BUILD_PROFILE', 'EXPO_PUBLIC_API_URL', 'GOOGLE_SERVICES_JSON'];

function configWith(env: Record<string, string>): ExpoConfig {
  const previous = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
  for (const key of KEYS) Reflect.deleteProperty(process.env, key);
  Object.assign(process.env, env);
  try {
    return appConfig({ config: {} } as Parameters<typeof appConfig>[0]);
  } finally {
    for (const key of KEYS) {
      const value = previous[key];
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
    }
  }
}

function pluginOptions(config: ExpoConfig, name: string): Record<string, unknown> {
  const entry = config.plugins?.find((p) => Array.isArray(p) && p[0] === name);
  if (!Array.isArray(entry)) throw new Error(`${name} is not configured`);
  return entry[1] as Record<string, unknown>;
}

const STORE = {
  EAS_BUILD_PROFILE: 'production',
  EXPO_PUBLIC_API_URL: 'https://api.hamropasal.np',
};

describe('production app config (Phase 7)', () => {
  it.each(['customer', 'seller'])(
    'the %s store build carries what push and the stores need',
    (variant) => {
      const config = configWith({
        ...STORE,
        EAS_BUILD_PROFILE: variant === 'seller' ? 'seller-production' : 'production',
        APP_VARIANT: variant,
        GOOGLE_SERVICES_JSON: '/eas/secrets/google-services.json',
      });
      expect(config.version).toBe(APP_VERSION);
      expect(config.android).toMatchObject({
        googleServicesFile: '/eas/secrets/google-services.json',
        permissions: ['android.permission.POST_NOTIFICATIONS', 'android.permission.VIBRATE'],
        blockedPermissions: ['android.permission.RECORD_AUDIO'],
      });
      expect(config.ios).toMatchObject({ infoPlist: { ITSAppUsesNonExemptEncryption: false } });
      // The new-order alarm rings with the bundled sound on the order-alarm channel.
      expect(pluginOptions(config, 'expo-notifications')).toMatchObject({
        sounds: ['./assets/sounds/vendor-alarm.wav'],
        defaultChannel: 'orders',
        enableBackgroundRemoteNotifications: true,
      });
    },
  );

  it('builds locally without a Firebase file (no push token, nothing else lost)', () => {
    expect(configWith({}).android?.googleServicesFile).toBeUndefined();
  });

  it('refuses a store build without an https API, and only a store build', () => {
    for (const profile of ['production', 'seller-production']) {
      expect(() => {
        assertStoreBuildEnv({ EAS_BUILD_PROFILE: profile });
      }).toThrow('EXPO_PUBLIC_API_URL');
      expect(() => {
        assertStoreBuildEnv({
          EAS_BUILD_PROFILE: profile,
          EXPO_PUBLIC_API_URL: 'http://192.168.1.20:4000',
        });
      }).toThrow('https');
      expect(() => {
        assertStoreBuildEnv({ ...STORE, EAS_BUILD_PROFILE: profile });
      }).not.toThrow();
    }
    expect(() => {
      assertStoreBuildEnv({ EAS_BUILD_PROFILE: 'development' });
    }).not.toThrow();
    expect(() => {
      assertStoreBuildEnv({});
    }).not.toThrow();
    expect(() => configWith({ EAS_BUILD_PROFILE: 'production' })).toThrow('EXPO_PUBLIC_API_URL');
  });

  it('matches eas.json: every store profile is an app bundle in the production environment', () => {
    const fs = jest.requireActual<{ readFileSync: (path: string, encoding: 'utf8') => string }>(
      'node:fs',
    );
    const eas = JSON.parse(fs.readFileSync(`${__dirname}/../../eas.json`, 'utf8')) as {
      build: Record<
        string,
        {
          extends?: string;
          environment?: string;
          android?: { buildType?: string };
          env?: { APP_VARIANT?: string };
        }
      >;
    };
    const resolve = (name: string): Record<string, unknown> => {
      const profile = eas.build[name];
      if (profile === undefined) throw new Error(`no profile ${name}`);
      const parent = profile.extends === undefined ? {} : resolve(profile.extends);
      return {
        ...parent,
        ...profile,
        android: { ...(parent.android as object), ...profile.android },
      };
    };
    expect(resolve('production')).toMatchObject({
      environment: 'production',
      android: { buildType: 'app-bundle' },
      env: { APP_VARIANT: 'customer' },
    });
    expect(resolve('seller-production')).toMatchObject({
      environment: 'production',
      android: { buildType: 'app-bundle' },
      env: { APP_VARIANT: 'seller' },
    });
  });
});

declare const __dirname: string;
