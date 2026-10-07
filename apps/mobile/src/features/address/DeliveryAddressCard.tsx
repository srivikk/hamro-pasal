import { useState } from 'react';
import { Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { AddressFormModal } from '../../components/AddressFormModal';
import { Button } from '../../components/Button';
import { selectSelectedAddress, useAddressStore } from '../../store/useAddressStore';
import { AddressBookModal, AddressSummary } from './AddressBookModal';

/**
 * The delivery address of this order in the cart. With an empty book it opens the form directly;
 * otherwise "Change" opens the address book (choose another, add, edit, remove). The book is kept
 * in encrypted MMKV, so it is already filled in on the next visit.
 */
export function DeliveryAddressCard({ disabled = false }: { disabled?: boolean }) {
  const { t } = useTranslation();
  const selected = useAddressStore(selectSelectedAddress);
  const saveAddress = useAddressStore((state) => state.saveAddress);
  const [open, setOpen] = useState(false);

  return (
    <View className="gap-3 rounded-2xl bg-gray-50 p-3" testID="delivery-address">
      <Text className="text-sm font-semibold text-gray-700">{t('cart.deliverTo')}</Text>
      {selected === null ? (
        <Button
          label={t('cart.addAddress')}
          variant="secondary"
          size="sm"
          disabled={disabled}
          onPress={() => {
            setOpen(true);
          }}
        />
      ) : (
        <View className="flex-row items-center gap-3">
          <AddressSummary entry={selected} />
          <Button
            label={t('cart.changeAddress')}
            variant="secondary"
            size="sm"
            disabled={disabled}
            onPress={() => {
              setOpen(true);
            }}
          />
        </View>
      )}
      <AddressFormModal
        visible={open && selected === null}
        initial={null}
        onSave={(draft) => {
          saveAddress(draft);
          setOpen(false);
        }}
        onClose={() => {
          setOpen(false);
        }}
      />
      <AddressBookModal
        visible={open && selected !== null}
        onClose={() => {
          setOpen(false);
        }}
      />
    </View>
  );
}
