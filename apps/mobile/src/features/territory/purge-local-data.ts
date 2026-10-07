import type { QueryClient } from '@tanstack/react-query';

import { useVendorFinanceStore } from '../vendor/vendor-finance-mocks';
import { getAppStorage } from '../../storage/app-mmkv';
import { getSecureStorage } from '../../storage/secure-mmkv';
import { useAddressStore } from '../../store/useAddressStore';
import { useAuthStore } from '../../store/useAuthStore';
import { useBrowseLocationStore } from '../../store/useBrowseLocationStore';
import { useCartStore } from '../../store/useCartStore';
import { useCheckoutStore } from '../../store/useCheckoutStore';
import { useDeliveryOtpStore } from '../../store/useDeliveryOtpStore';
import { useFavouritesStore } from '../../store/useFavouritesStore';
import { useOnboardingStore } from '../../store/useOnboardingStore';
import { useOrderReceiptStore } from '../../store/useOrderReceiptStore';
import { useOrderStore } from '../../store/useOrderStore';
import { useProfileStore } from '../../store/useProfileStore';
import { useVendorBoardStore } from '../../store/useVendorBoardStore';
import { useVendorCatalogueStore } from '../../store/useVendorCatalogueStore';
import { useVendorMarketingStore } from '../../store/useVendorMarketingStore';
import { useVendorShopStore } from '../../store/useVendorShopStore';

/**
 * SPEC §1: outside the service territory the app clears its local cache. Everything goes: server
 * data cached by TanStack Query, every store (in memory and on disk: cart, checkout, orders,
 * delivery codes, address book, profile, session tokens and preferences).
 *
 * Kept: the MMKV encryption key in the OS keychain (expo-secure-store). It holds no user data and
 * keeping it lets the encrypted instance be reused if the customer returns to Nepal.
 */
export function purgeLocalData(queryClient: QueryClient): void {
  queryClient.cancelQueries().catch(() => undefined);
  queryClient.clear();

  // Reset memory first (each persisted store writes its empty state), then wipe the files.
  useCartStore.setState(useCartStore.getInitialState(), true);
  useCheckoutStore.setState(useCheckoutStore.getInitialState(), true);
  useOrderStore.setState(useOrderStore.getInitialState(), true);
  useDeliveryOtpStore.setState(useDeliveryOtpStore.getInitialState(), true);
  useAddressStore.setState(useAddressStore.getInitialState(), true);
  useProfileStore.setState(useProfileStore.getInitialState(), true);
  useBrowseLocationStore.setState(useBrowseLocationStore.getInitialState(), true);
  useOnboardingStore.setState(useOnboardingStore.getInitialState(), true);
  useAuthStore.setState(useAuthStore.getInitialState(), true);
  useOrderReceiptStore.setState(useOrderReceiptStore.getInitialState(), true);
  useFavouritesStore.setState(useFavouritesStore.getInitialState(), true);
  useVendorShopStore.setState(useVendorShopStore.getInitialState(), true);
  useVendorBoardStore.getState().reset();
  useVendorCatalogueStore.getState().reset();
  useVendorMarketingStore.getState().reset();
  useVendorFinanceStore.setState(useVendorFinanceStore.getInitialState(), true);

  getAppStorage().clearAll();
  getSecureStorage().clearAll();
}
