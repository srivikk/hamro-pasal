import { Modal, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { Button } from '../../components/Button';

export interface DeliveryAreaModalProps {
  visible: boolean;
  vendorName: string;
  onChangeAddress: () => void;
  onClose: () => void;
}

/** Shown instead of checking out when the shop does not deliver to the delivery address. */
export function DeliveryAreaModal({
  visible,
  vendorName,
  onChangeAddress,
  onClose,
}: DeliveryAreaModalProps) {
  const { t } = useTranslation();
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View className="flex-1 items-center justify-center bg-black/50 px-6">
        <View className="w-full gap-4 rounded-2xl bg-white p-5" testID="delivery-area-modal">
          <Text className="text-lg font-bold text-gray-900" accessibilityRole="header">
            {t('deliveryArea.title')}
          </Text>
          <Text className="text-base text-gray-700">
            {t('deliveryArea.body', { vendor: vendorName })}
          </Text>
          <Button label={t('deliveryArea.changeAddress')} onPress={onChangeAddress} />
          <Button label={t('deliveryArea.close')} variant="secondary" onPress={onClose} />
        </View>
      </View>
    </Modal>
  );
}
