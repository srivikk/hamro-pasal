import { Modal, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { useCartStore } from '../store/useCartStore';
import { Button } from './Button';

/**
 * SPEC edge case 4: adding from a second vendor must be confirmed before the cart is cleared.
 * Visible whenever the cart store holds a `pendingAddition`.
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
        <View className="w-full rounded-2xl bg-white p-6">
          <Text className="text-xl font-bold text-neutral-900">{t('cartConflict.title')}</Text>
          <Text className="mt-2 text-base text-neutral-700">
            {t('cartConflict.message', {
              current: currentVendor?.name ?? '',
              next: pending?.vendor.name ?? '',
            })}
          </Text>
          <View className="mt-6 gap-3">
            <Button label={t('cartConflict.confirm')} onPress={confirmReplaceCart} />
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
