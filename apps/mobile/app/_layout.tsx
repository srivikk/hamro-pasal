// Fail fast: evaluating the API config throws a descriptive error if EXPO_PUBLIC_API_URL is missing.
import '../src/config/api';
import '../global.css';

import { QueryClientProvider } from '@tanstack/react-query';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useState } from 'react';
import { I18nextProvider } from 'react-i18next';

import { createQueryClient } from '../src/api/query-client';
import { ReplaceCartModal } from '../src/components/ReplaceCartModal';
import { CheckoutSessionWatcher } from '../src/features/checkout/CheckoutSessionWatcher';
import { bindLocale, createI18n } from '../src/i18n/i18n';
import { useAuthStore } from '../src/store/useAuthStore';

// The auth store hydrates synchronously from MMKV, so the persisted locale is known here.
const i18n = createI18n(useAuthStore.getState().locale);
bindLocale(i18n, useAuthStore);

export default function RootLayout() {
  const [queryClient] = useState(createQueryClient);

  return (
    <QueryClientProvider client={queryClient}>
      <I18nextProvider i18n={i18n}>
        <Stack screenOptions={{ headerShown: false }} />
        {/* Mounted above every route: tabs and the vendor menu both add to the cart. */}
        <ReplaceCartModal />
        <CheckoutSessionWatcher />
        <StatusBar style="auto" />
      </I18nextProvider>
    </QueryClientProvider>
  );
}
