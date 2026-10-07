import { Modal, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { useCartStore } from '../store/useCartStore';
import { Button } from './Button';

/**
 * SPEC edge case 4: a cart holds one shop's items. Adding from another shop is blocked (the
 * store keeps the item as `pendingAddition`) and this alert asks: "Clear Cart" discards the
 * current cart and starts the new order with that item; "Cancel" keeps the cart as it is.
 */
export function ReplaceCartModal() {
  const { t } = useTranslation();
  const pending = useCartStore((state) => state.pendingAddition);
  const currentVendor = useCartStore((state) => state.vendor);
  const confirmReplaceCart = useCartStore((state) => state.confirmReplaceCart);
  const dismissReplaceCart = useCartStore((state) => state.dismissReplaceCart);

  return (
    <Modal
      transparent
      animationType="fade"
      visible={pending !== null}
      onRequestClose={dismissReplaceCart}
    >
      <View className="flex-1 items-center justify-center bg-black/50 px-6">
        <View className="w-full rounded-2xl bg-white p-6" testID="cart-conflict-alert">
          <Text className="text-xl font-bold text-gray-900">{t('cartConflict.title')}</Text>
          <Text className="mt-2 text-base text-gray-700">
            {t('cartConflict.message', {
              current: currentVendor?.name ?? '',
              next: pending?.vendor.name ?? '',
            })}
          </Text>
          <View className="mt-6 gap-3">
            <Button
              label={t('cartConflict.confirm')}
              variant="danger"
              onPress={confirmReplaceCart}
            />
            <Button
              label={t('cartConflict.cancel')}
              variant="secondary"
              onPress={dismissReplaceCart}
            />
          </View>
        </View>
      </View>
    </Modal>
  );
}
