import { Switch, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { useVendorShopStore } from '../../store/useVendorShopStore';
import { colors } from '../../theme/colors';

/**
 * The Online / Offline switch in every Vendor App header: whether the shop takes new orders.
 *
 * TODO: send it to the server (`PUT /api/vendor/availability`, STATE_HANDOFF.md §8Z.12). Until
 * that exists the choice is kept on the phone and does not stop real orders.
 */
export function VendorOnlineToggle() {
  const { t } = useTranslation();
  const online = useVendorShopStore((state) => state.online);
  const setOnline = useVendorShopStore((state) => state.setOnline);
  const label = t(online ? 'vendorShop.online' : 'vendorShop.offline');

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
        onValueChange={setOnline}
        // Switch takes raw colours, not a className.
        trackColor={{ true: colors.success, false: colors.inactive }}
      />
    </View>
  );
}
