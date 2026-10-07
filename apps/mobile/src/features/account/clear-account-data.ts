import type { QueryClient } from '@tanstack/react-query';

import { useAddressStore } from '../../store/useAddressStore';
import { useAuthStore } from '../../store/useAuthStore';
import { useCartStore } from '../../store/useCartStore';
import { useCheckoutStore } from '../../store/useCheckoutStore';
import { useDeliveryOtpStore } from '../../store/useDeliveryOtpStore';
import { useFavouritesStore } from '../../store/useFavouritesStore';
import { useOrderReceiptStore } from '../../store/useOrderReceiptStore';
import { useOrderStore } from '../../store/useOrderStore';
import { useProfileStore } from '../../store/useProfileStore';

/**
 * After an account deletion request: ends the session and removes everything personal this phone
 * holds for the account (profile, consents, address book, orders and receipts, delivery codes,
 * favourites, cart). Device preferences stay: language, theme, and the onboarding answers.
 */
export function clearAccountData(queryClient: QueryClient): void {
  queryClient.cancelQueries().catch(() => undefined);
  useAuthStore.getState().clearSession();
  queryClient.clear();

  useCartStore.setState(useCartStore.getInitialState(), true);
  useCheckoutStore.setState(useCheckoutStore.getInitialState(), true);
  useOrderStore.setState(useOrderStore.getInitialState(), true);
  useOrderReceiptStore.setState(useOrderReceiptStore.getInitialState(), true);
  useDeliveryOtpStore.setState(useDeliveryOtpStore.getInitialState(), true);
  useAddressStore.setState(useAddressStore.getInitialState(), true);
  useFavouritesStore.setState(useFavouritesStore.getInitialState(), true);
  useProfileStore.setState(useProfileStore.getInitialState(), true);
}
