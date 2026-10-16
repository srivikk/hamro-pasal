import * as Linking from 'expo-linking';

import { SELLER_APP_SIGNUP_URL, SELLER_APP_STORE_URL } from '../../lib/app-variant';

/**
 * Step 7.7 (SPEC core 11): "Become a Seller" opens the Seller app's signup when it is installed
 * (its own scheme), else its store page. The same number then signs in there as the seller.
 */
export async function openSellerSignup(
  open: (url: string) => Promise<unknown> = Linking.openURL,
): Promise<'APP' | 'STORE'> {
  try {
    await open(SELLER_APP_SIGNUP_URL);
    return 'APP';
  } catch {
    await open(SELLER_APP_STORE_URL);
    return 'STORE';
  }
}
