import { useState } from 'react';
import { Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { AddressFormModal } from '../../components/AddressFormModal';
import { Button } from '../../components/Button';
import { formatLocalizedNumber } from '../../i18n/format-number';
import { useAddressStore } from '../../store/useAddressStore';
import { useAuthStore } from '../../store/useAuthStore';
import { formatAddressLine } from './address-form';

/**
 * The active delivery address in the cart, with add / change. The address is kept in encrypted
 * MMKV, so it is already filled in on the next visit.
 */
export function DeliveryAddressCard({ disabled = false }: { disabled?: boolean }) {
  const { t } = useTranslation();
  const locale = useAuthStore((state) => state.locale);
  const address = useAddressStore((state) => state.address);
  const setAddress = useAddressStore((state) => state.setAddress);
  const [editing, setEditing] = useState(false);

  return (
    <View className="gap-2 rounded-xl border border-neutral-200 p-3" testID="delivery-address">
      <Text className="text-sm font-semibold text-neutral-700">{t('cart.deliverTo')}</Text>
      {address === null ? (
        <Button
          label={t('cart.addAddress')}
          variant="secondary"
          size="sm"
          disabled={disabled}
          onPress={() => {
            setEditing(true);
          }}
        />
      ) : (
        <View className="flex-row items-center gap-3">
          <View className="flex-1">
            <Text className="text-sm text-neutral-900" testID="delivery-address-line">
              {formatAddressLine(address, formatLocalizedNumber(address.ward_number, locale))}
            </Text>
            <Text className="text-xs text-neutral-500">{address.landmark}</Text>
          </View>
          <Button
            label={t('cart.changeAddress')}
            variant="secondary"
            size="sm"
            disabled={disabled}
            onPress={() => {
              setEditing(true);
            }}
          />
        </View>
      )}
      <AddressFormModal
        visible={editing}
        initial={address}
        onSave={(saved) => {
          setAddress(saved);
          setEditing(false);
        }}
        onClose={() => {
          setEditing(false);
        }}
      />
    </View>
  );
}
