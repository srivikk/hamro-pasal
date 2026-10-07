import { useAuthStore } from '../../store/useAuthStore';
import { selectSessionUserId } from '../../store/useProfileStore';
import { settingsFor, useVendorShopStore } from '../../store/useVendorShopStore';
import type { ShopSettings } from './shop-settings';

/** The signed-in vendor's saved shop settings, or null when this account has saved none. */
export function useShopSettings(): ShopSettings | null {
  const userId = useAuthStore(selectSessionUserId);
  const stored = useVendorShopStore((state) => state.stored);
  return settingsFor(stored, userId);
}

/** Saves the settings for the signed-in account. */
export function useSaveShopSettings(): (settings: ShopSettings) => void {
  const userId = useAuthStore(selectSessionUserId);
  const save = useVendorShopStore((state) => state.saveSettings);
  return (settings) => {
    save(settings, userId);
  };
}
