import { Redirect } from 'expo-router';

import { isSellerApp } from '../src/lib/app-variant';
import { selectHasSession, useAuthStore } from '../src/store/useAuthStore';

/**
 * Step 7.7: `hamropasalseller://signup`, opened by the customer app's "Become a Seller". The
 * signup starts with the +977 sign-in (a number without a shop is then asked for its shop's
 * details); a signed-in vendor goes to its application.
 */
export default function SignupLink() {
  const isVendor = useAuthStore((state) => selectHasSession(state) && state.role === 'VENDOR');
  if (!isSellerApp()) return <Redirect href="/" />;
  return <Redirect href={isVendor ? '/seller-application' : '/login'} />;
}
