import Constants from 'expo-constants';

/*
 * Step 7.7: which store build this is (app.config.ts `extra.appVariant`): the customer app
 * "Hamro Pasal" or the vendor app "Hamro Pasal Seller". It decides the role the app signs in with
 * (POST /api/auth/otp/verify `app`) and which screens are mounted.
 */

export type AppVariant = 'CUSTOMER' | 'SELLER';

function fromConfig(): AppVariant {
  const extra: unknown = Constants.expoConfig?.extra;
  const value =
    typeof extra === 'object' && extra !== null
      ? (extra as Record<string, unknown>).appVariant
      : undefined;
  return value === 'seller' ? 'SELLER' : 'CUSTOMER';
}

let current: AppVariant = fromConfig();

export function appVariant(): AppVariant {
  return current;
}

export function isSellerApp(): boolean {
  return current === 'SELLER';
}

/** Tests only: run a test as the other build. */
export function setAppVariantForTests(variant: AppVariant): void {
  current = variant;
}

/** The Seller app's own link, opened from the customer app's "Become a Seller". */
export const SELLER_APP_SIGNUP_URL = 'hamropasalseller://signup';

/** Where "Become a Seller" goes when the Seller app is not installed (its store page). */
export const SELLER_APP_STORE_URL =
  process.env.EXPO_PUBLIC_SELLER_STORE_URL ??
  'https://play.google.com/store/apps/details?id=com.hamro.pasal.seller';
