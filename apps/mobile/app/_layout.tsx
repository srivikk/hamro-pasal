// Fail fast: evaluating the API config throws a descriptive error if EXPO_PUBLIC_API_URL is missing.
import '../src/config/api';
import '../global.css';

import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useColorScheme } from 'nativewind';
import { useEffect, useState } from 'react';
import { I18nextProvider } from 'react-i18next';

import { bindQueryFocusToAppState } from '../src/api/app-focus';
import { createQueryClient } from '../src/api/query-client';
import { ReplaceCartModal } from '../src/components/ReplaceCartModal';
import { ToastHost } from '../src/components/Toast';
import { useSessionExpiryHandler } from '../src/features/auth/useSessionExpiryHandler';
import { CheckoutSessionWatcher } from '../src/features/checkout/CheckoutSessionWatcher';
import { configureForegroundNotifications } from '../src/features/notifications/notification-handler';
import { PushNotifications } from '../src/features/notifications/PushNotifications';
import { ReviewPrompt } from '../src/features/review/ReviewPrompt';
import { TerritoryGate } from '../src/features/territory/TerritoryGate';
import { bindLocale, createI18n } from '../src/i18n/i18n';
import { startDevMocks } from '../src/mocks/dev-mocks';
import { useAuthStore } from '../src/store/useAuthStore';
import { useThemeStore } from '../src/store/useThemeStore';
import { bindTheme } from '../src/theme/apply-theme';

// The auth store hydrates synchronously from MMKV, so the persisted locale is known here.
const i18n = createI18n(useAuthStore.getState().locale);
bindLocale(i18n, useAuthStore);

// The theme store hydrates synchronously too: Light / Dark / System is applied before the first
// frame and again whenever Profile → Appearance changes it.
bindTheme(useThemeStore);

// Development builds only, and only when asked for: answers the not-yet-built account endpoints.
startDevMocks();

// Phase 20: without a handler, a push that arrives while the app is open shows nothing.
configureForegroundNotifications();

/** Hooks that need the i18n provider live below it. */
function SessionExpiryHandler({ queryClient }: { queryClient: QueryClient }) {
  useSessionExpiryHandler(queryClient);
  return null;
}

export default function RootLayout() {
  const [queryClient] = useState(createQueryClient);
  // React Query learns when the app returns to the foreground (opted-in queries then refetch).
  useEffect(() => bindQueryFocusToAppState(), []);
  // Headers, the tab bar and screen backgrounds follow the app theme with the dark: classes.
  const { colorScheme } = useColorScheme();

  return (
    <QueryClientProvider client={queryClient}>
      <I18nextProvider i18n={i18n}>
        <SessionExpiryHandler queryClient={queryClient} />
        {/* Asks for the notification permission and registers the push token once signed in. */}
        <PushNotifications />
        <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
          <Stack screenOptions={{ headerShown: false }} />
        </ThemeProvider>
        {/* Mounted above every route: tabs and the vendor menu both add to the cart. */}
        <ReplaceCartModal />
        <CheckoutSessionWatcher />
        <ReviewPrompt />
        <ToastHost />
        {/* SPEC §1 tenant isolation: last, so it sits above every route and modal. */}
        <TerritoryGate />
        <StatusBar style="auto" />
      </I18nextProvider>
    </QueryClientProvider>
  );
}
