import { Redirect, Stack } from 'expo-router';

import { selectHasSession, useAuthStore } from '../../src/store/useAuthStore';

/**
 * Driver-only routes (platform fleet riders). Anyone who is not a signed-in DRIVER is sent to the
 * customer app. The API enforces the role on every call; this only keeps the screens apart.
 */
export default function DriverLayout() {
  const isDriver = useAuthStore((state) => selectHasSession(state) && state.role === 'DRIVER');
  if (!isDriver) return <Redirect href="/" />;
  return <Stack />;
}
