import type { ConfigContext, ExpoConfig } from 'expo/config';

/*
 * Step 7.7 (SPEC core 11, decided 2026-10-15): two store builds from one codebase. APP_VARIANT
 * picks the build: `customer` (default) is "Hamro Pasal", `seller` is "Hamro Pasal Seller", each
 * with its own name, slug, URL scheme and package / bundle id, so both install side by side.
 * The app reads `extra.appVariant` (src/lib/app-variant.ts) to sign in with the right role and
 * to mount only its own screens. Riders stay in the customer build.
 */

type Variant = 'customer' | 'seller';

const VARIANTS: Readonly<
  Record<Variant, { name: string; slug: string; scheme: string; bundleId: string }>
> = {
  customer: {
    name: 'Hamro Pasal',
    slug: 'hamro-pasal',
    scheme: 'hamropasal',
    bundleId: 'com.hamro.pasal',
  },
  seller: {
    name: 'Hamro Pasal Seller',
    slug: 'hamro-pasal-seller',
    scheme: 'hamropasalseller',
    bundleId: 'com.hamro.pasal.seller',
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
  return {
    ...config,
    name: app.name,
    slug: app.slug,
    scheme: app.scheme,
    version: '0.0.0',
    orientation: 'portrait',
    userInterfaceStyle: 'automatic',
    plugins: [
      'expo-router',
      'expo-secure-store',
      [
        'expo-notifications',
        {
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
        // EAS ties a project to its slug: the Seller app gets its own (`eas init` with
        // APP_VARIANT=seller), given here; until then it shares the customer project.
        projectId:
          variant === 'seller' && process.env.EAS_PROJECT_ID_SELLER !== undefined
            ? process.env.EAS_PROJECT_ID_SELLER
            : 'f91dc398-deb8-4af4-9b50-0210e8cb080f',
      },
      appVariant: variant,
    },
    android: {
      package: app.bundleId,
    },
    ios: {
      bundleIdentifier: app.bundleId,
    },
  };
};
