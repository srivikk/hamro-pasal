import { Redirect, Stack } from 'expo-router';

import { selectHasSession, useAuthStore } from '../../src/store/useAuthStore';

/**
 * Vendor-only routes. Anyone who is not a signed-in VENDOR (a customer, or a vendor who just signed
 * out) is sent to the customer app. The API enforces the role on every call; this only keeps the
 * screens apart.
 */
export default function VendorLayout() {
  const isVendor = useAuthStore((state) => selectHasSession(state) && state.role === 'VENDOR');
  if (!isVendor) return <Redirect href="/" />;
  return <Stack />;
}
