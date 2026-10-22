import type { ConfigContext, ExpoConfig } from 'expo/config';

import appVersion from './src/features/settings/app-version.json';
import palette from './src/theme/palette.json';

/*
 * Step 7.7 (SPEC core 11, decided 2026-10-15): two store builds from one codebase. APP_VARIANT
 * picks the build: `customer` (default) is "Hamro Pasal", `seller` is "Hamro Pasal Seller", each
 * with its own name, URL scheme and package / bundle id, so both install side by side. Both are
 * one EAS project (one slug and project id; EAS refuses a slug that differs from the project's),
 * which builds and signs each package separately: Expo's documented app-variant setup.
 * The app reads `extra.appVariant` (src/lib/app-variant.ts) to sign in with the right role and
 * to mount only its own screens. Riders stay in the customer build.
 *
 * Step 7.9: each build takes its icon, adaptive icon, splash and notification icon from
 * assets/branding/<variant>/ (see the README there) and its colours from src/theme/palette.json.
 * The files there now are PLACEHOLDERS: replace them, keeping the names, then rebuild the
 * development client (native assets are not hot-reloaded).
 */

type Variant = 'customer' | 'seller';

const VARIANTS: Readonly<
  Record<
    Variant,
    {
      name: string;
      scheme: string;
      bundleId: string;
      /** Behind the adaptive icon and the light splash; the Seller app is a shade darker. */
      accent: string;
    }
  >
> = {
  customer: {
    name: 'Hamro Pasal',
    scheme: 'hamropasal',
    bundleId: 'com.hamro.pasal',
    accent: palette.brand.DEFAULT,
  },
  seller: {
    name: 'Hamro Pasal Seller',
    scheme: 'hamropasalseller',
    bundleId: 'com.hamro.pasal.seller',
    accent: palette.brand.dark,
  },
};

/** The EAS build profiles that produce store binaries (eas.json). */
const STORE_PROFILES = new Set(['production', 'seller-production']);

/**
 * Phase 7 (2026-10-22): a store build without a reachable API would install and then fail at the
 * first screen (src/config/api.ts). Refuse it while it is built instead: a production profile
 * needs EXPO_PUBLIC_API_URL over https (set in the EAS "production" environment).
 */
export function assertStoreBuildEnv(env: Readonly<Record<string, string | undefined>>): void {
  if (!STORE_PROFILES.has(env.EAS_BUILD_PROFILE ?? '')) return;
  const api = env.EXPO_PUBLIC_API_URL ?? '';
  if (!/^https:\/\/[^\s/]+/.test(api)) {
    throw new Error(
      `EAS profile "${env.EAS_BUILD_PROFILE ?? ''}" needs EXPO_PUBLIC_API_URL set to the https API (got "${api}")`,
    );
  }
}

function variantOf(value: string | undefined): Variant {
  if (value === undefined || value === '' || value === 'customer') return 'customer';
  if (value === 'seller') return 'seller';
  throw new Error(`APP_VARIANT must be "customer" or "seller", got "${value}"`);
}

export default ({ config }: ConfigContext): ExpoConfig => {
  assertStoreBuildEnv(process.env);
  const variant = variantOf(process.env.APP_VARIANT);
  const app = VARIANTS[variant];
  const assets = `./assets/branding/${variant}`;
  return {
    ...config,
    name: app.name,
    slug: 'hamro-pasal',
    scheme: app.scheme,
    // The version users see (Profile, About) and the stores' version name; build numbers are
    // EAS's (appVersionSource remote, autoIncrement in eas.json).
    version: appVersion.version,
    orientation: 'portrait',
    userInterfaceStyle: 'automatic',
    icon: `${assets}/icon.png`,
    plugins: [
      'expo-router',
      'expo-secure-store',
      [
        'expo-splash-screen',
        {
          image: `${assets}/splash-icon.png`,
          imageWidth: 200,
          resizeMode: 'contain',
          backgroundColor: app.accent,
          dark: { image: `${assets}/splash-icon.png`, backgroundColor: palette.surface.dark },
        },
      ],
      [
        'expo-notifications',
        {
          // Android draws the small icon as a white silhouette, tinted with `color`.
          icon: `${assets}/notification-icon.png`,
          color: palette.brand.DEFAULT,
          defaultChannel: 'orders',
          enableBackgroundRemoteNotifications: true,
          // 2026-10-21: bundled so a new order can ring the shop's phone (ORDER_ALARM_SOUND).
          // Takes effect in a new development or store build, not over the air.
          sounds: ['./assets/sounds/vendor_alarm.wav'],
        },
      ],
      [
        'expo-location',
        {
          locationWhenInUsePermission:
            'Hamro Pasal uses your location to confirm that service is available in Nepal and to pin your delivery address.',
        },
      ],
      [
        'expo-image-picker',
        {
          photosPermission:
            "Hamro Pasal needs access to your photos so you can attach evidence to a dispute or upload your shop's PAN document.",
          cameraPermission:
            "Hamro Pasal needs your camera so you can photograph your shop's PAN document for verification.",
          microphonePermission: false,
        },
      ],
      'expo-sharing',
    ],
    experiments: {
      typedRoutes: true,
    },
    extra: {
      router: {},
      eas: {
        // Shared by both variants (see the top of this file).
        projectId: 'f91dc398-deb8-4af4-9b50-0210e8cb080f',
      },
      appVariant: variant,
    },
    android: {
      package: app.bundleId,
      // FCM V1 credentials for Android push (Expo's push service delivers through FCM). The file
      // holds a client for both packages; EAS provides it as the file environment variable
      // GOOGLE_SERVICES_JSON. Absent locally: the build still works, it just gets no push token.
      ...(process.env.GOOGLE_SERVICES_JSON === undefined || process.env.GOOGLE_SERVICES_JSON === ''
        ? {}
        : { googleServicesFile: process.env.GOOGLE_SERVICES_JSON }),
      // POST_NOTIFICATIONS (Android 13+) and VIBRATE for the order alarm channel; the channels
      // themselves ("orders", "order-alarm-v2" with the bundled vendor_alarm sound) are created by
      // the app at start (src/features/notifications/notification-handler.ts).
      permissions: ['android.permission.POST_NOTIFICATIONS', 'android.permission.VIBRATE'],
      // Nothing records audio (voice search is a placeholder): keep the store listing honest.
      blockedPermissions: ['android.permission.RECORD_AUDIO'],
      adaptiveIcon: {
        foregroundImage: `${assets}/adaptive-icon.png`,
        backgroundColor: app.accent,
      },
    },
    ios: {
      bundleIdentifier: app.bundleId,
      supportsTablet: false,
      // Only standard HTTPS / TLS: no export-compliance documents for App Store submission.
      infoPlist: { ITSAppUsesNonExemptEncryption: false },
    },
  };
};
