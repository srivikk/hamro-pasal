import type { ConfigContext, ExpoConfig } from 'expo/config';

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

function variantOf(value: string | undefined): Variant {
  if (value === undefined || value === '' || value === 'customer') return 'customer';
  if (value === 'seller') return 'seller';
  throw new Error(`APP_VARIANT must be "customer" or "seller", got "${value}"`);
}

export default ({ config }: ConfigContext): ExpoConfig => {
  const variant = variantOf(process.env.APP_VARIANT);
  const app = VARIANTS[variant];
  const assets = `./assets/branding/${variant}`;
  return {
    ...config,
    name: app.name,
    slug: 'hamro-pasal',
    scheme: app.scheme,
    version: '0.0.0',
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
      adaptiveIcon: {
        foregroundImage: `${assets}/adaptive-icon.png`,
        backgroundColor: app.accent,
      },
    },
    ios: {
      bundleIdentifier: app.bundleId,
    },
  };
};
