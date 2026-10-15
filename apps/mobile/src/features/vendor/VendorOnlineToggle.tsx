import { Switch, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { useVendorShopStore } from '../../store/useVendorShopStore';
import { useToastStore } from '../../store/useToastStore';
import { colors } from '../../theme/colors';
import { useVendorAvailability } from './useVendorAvailability';

/**
 * The Online / Offline switch in every Vendor App header: whether the shop takes new orders.
 * Step 7.3: it is the server's (`PUT /api/vendor/availability`). On means AUTO: the opening
 * hours decide, and an auto-paused shop resumes. Off means CLOSED until the next scheduled
 * boundary (indefinitely for a shop without hours). Until the server has answered, the phone's
 * last known standing is shown.
 */
export function VendorOnlineToggle() {
  const { t } = useTranslation();
  const localOnline = useVendorShopStore((state) => state.online);
  const showToast = useToastStore((state) => state.show);
  const { query, save } = useVendorAvailability();
  const server = query.data;
  const online = server?.open_now ?? localOnline;
  const label =
    server?.closed_reason === 'AUTO_PAUSED'
      ? t('vendorShop.paused')
      : t(online ? 'vendorShop.online' : 'vendorShop.offline');

  return (
    <View className="mr-3 flex-row items-center gap-2">
      <Text
        testID="vendor-online-label"
        className={`text-sm font-semibold ${online ? 'text-emerald-700' : 'text-gray-500'}`}
      >
        {label}
      </Text>
      <Switch
        testID="vendor-online-toggle"
        accessibilityLabel={t('vendorShop.toggleLabel')}
        value={online}
        disabled={save.isPending}
        onValueChange={(next) => {
          save.mutate(
            { mode: next ? 'AUTO' : 'CLOSED' },
            {
              onError: () => {
                showToast(t('vendorShop.availabilityFailed'), 'error');
              },
            },
          );
        }}
        // Switch takes raw colours, not a className.
        trackColor={{ true: colors.success, false: colors.inactive }}
      />
    </View>
  );
}
