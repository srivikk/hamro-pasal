import Ionicons from '@expo/vector-icons/Ionicons';
import { useState, type ComponentProps } from 'react';
import { Alert, Modal, Pressable, ScrollView, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AddressFormModal } from '../../components/AddressFormModal';
import { Button } from '../../components/Button';
import { formatLocalizedNumber } from '../../i18n/format-number';
import {
  isUniqueLabel,
  MAX_SAVED_ADDRESSES,
  useAddressStore,
  type AddressLabel,
  type SavedAddress,
} from '../../store/useAddressStore';
import { useAuthStore } from '../../store/useAuthStore';
import { colors } from '../../theme/colors';
import { formatNepalPhone } from '../auth/login-form';
import { formatAddressLine } from './address-form';

/** The tag's icon on its own tinted tile: Home yellow, Work blue, Other purple. */
export const ADDRESS_LABEL_STYLE: Record<
  AddressLabel,
  { icon: ComponentProps<typeof Ionicons>['name']; tile: string; color: string }
> = {
  HOME: { icon: 'home', tile: 'bg-amber-100', color: '#B45309' },
  WORK: { icon: 'briefcase', tile: 'bg-sky-100', color: '#0369A1' },
  OTHER: { icon: 'location', tile: 'bg-violet-100', color: '#6D28D9' },
};

/**
 * The saved entry a Home / Work draft would replace: another entry that already has the tag
 * (not the one being edited). Null for Other, or when the tag is free.
 */
export function tagHolder(
  addresses: readonly SavedAddress[],
  label: AddressLabel,
  editingId: string | undefined,
): SavedAddress | null {
  if (!isUniqueLabel(label)) return null;
  return addresses.find((entry) => entry.label === label && entry.id !== editingId) ?? null;
}

/** "Near Kathmandu Guest House, Thamel, Kathmandu Metropolitan City-26, Kathmandu". */
export function fullAddressText(entry: SavedAddress, ward: string): string {
  return `${entry.address.landmark}, ${formatAddressLine(entry.address, ward)}`;
}

/**
 * One saved address as a row: the tag's icon tile, the tag in bold, the whole address in words
 * (at most two lines) and, for an Other address, who receives the order.
 */
export function AddressSummary({ entry }: { entry: SavedAddress }) {
  const { t } = useTranslation();
  const locale = useAuthStore((state) => state.locale);
  const style = ADDRESS_LABEL_STYLE[entry.label];
  return (
    <View className="flex-1 flex-row items-start gap-3">
      <View
        className={`h-10 w-10 items-center justify-center rounded-xl ${style.tile}`}
        testID={`address-icon-${entry.label}`}
      >
        <Ionicons name={style.icon} size={20} color={style.color} />
      </View>
      <View className="flex-1">
        <Text className="text-base font-bold text-gray-900">
          {t(`address.label.${entry.label}`)}
        </Text>
        <Text
          className="mt-0.5 text-sm leading-5 text-gray-500"
          numberOfLines={2}
          testID="delivery-address-line"
        >
          {fullAddressText(entry, formatLocalizedNumber(entry.address.ward_number, locale))}
        </Text>
        {entry.recipient === null ? null : (
          <Text className="mt-1 text-xs text-gray-700" testID={`address-recipient-${entry.id}`}>
            {t('address.recipient.summary', {
              name: entry.recipient.name,
              phone: formatNepalPhone(entry.recipient.phone),
            })}
          </Text>
        )}
      </View>
    </View>
  );
}

function AddressBook({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const addresses = useAddressStore((state) => state.addresses);
  const selectedId = useAddressStore((state) => state.selectedId);
  const saveAddress = useAddressStore((state) => state.saveAddress);
  const selectAddress = useAddressStore((state) => state.selectAddress);
  const removeAddress = useAddressStore((state) => state.removeAddress);
  // 'new' adds an address; an id edits that one; null shows the list.
  const [editing, setEditing] = useState<string | null>(null);
  const full = addresses.length >= MAX_SAVED_ADDRESSES;

  return (
    <SafeAreaView className="flex-1 bg-gray-50">
      <View className="flex-row items-center gap-2 bg-white px-2 py-3 shadow-sm">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('common.back')}
          testID="address-book-back"
          hitSlop={8}
          className="h-10 w-10 items-center justify-center rounded-full active:bg-gray-100"
          onPress={onClose}
        >
          <Ionicons name="arrow-back" size={22} color="#111827" />
        </Pressable>
        <Text className="text-xl font-bold text-gray-900">{t('addressBook.title')}</Text>
      </View>
      <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('addressBook.add')}
          accessibilityState={{ disabled: full }}
          disabled={full}
          testID="address-add"
          className={`flex-row items-center gap-3 rounded-2xl bg-white p-4 shadow-sm active:bg-gray-100 ${
            full ? 'opacity-40' : ''
          }`}
          onPress={() => {
            setEditing('new');
          }}
        >
          <Ionicons name="add" size={22} color={colors.brand} />
          <Text className="flex-1 text-base font-semibold text-brand">{t('addressBook.add')}</Text>
          <Ionicons name="chevron-forward" size={18} color={colors.inactive} />
        </Pressable>
        {full ? (
          <Text className="text-center text-sm text-amber-800">
            {t('addressBook.full', { max: MAX_SAVED_ADDRESSES })}
          </Text>
        ) : null}

        {addresses.length === 0 ? (
          <Text className="pt-6 text-center text-base text-gray-500">{t('addressBook.empty')}</Text>
        ) : (
          <Text className="pt-2 text-xs font-bold uppercase tracking-wide text-gray-500">
            {t('addressBook.saved')}
          </Text>
        )}
        {addresses.map((entry) => {
          const selected = entry.id === selectedId;
          return (
            <View
              key={entry.id}
              testID={`address-entry-${entry.id}`}
              className={`gap-3 rounded-2xl bg-white p-4 shadow-sm ${
                selected ? 'border border-brand' : ''
              }`}
            >
              <Pressable
                accessibilityRole="radio"
                accessibilityState={{ selected }}
                accessibilityLabel={t('addressBook.deliverHere', {
                  label: t(`address.label.${entry.label}`),
                })}
                testID={`address-select-${entry.id}`}
                className="flex-row items-start"
                onPress={() => {
                  selectAddress(entry.id);
                  onClose();
                }}
              >
                <AddressSummary entry={entry} />
                {selected ? (
                  <Ionicons name="checkmark-circle" size={22} color={colors.brand} />
                ) : null}
              </Pressable>
              <View className="flex-row gap-2">
                <Button
                  label={t('addressBook.edit')}
                  size="sm"
                  variant="secondary"
                  testID={`address-edit-${entry.id}`}
                  onPress={() => {
                    setEditing(entry.id);
                  }}
                />
                <Button
                  label={t('addressBook.remove')}
                  size="sm"
                  variant="danger"
                  testID={`address-remove-${entry.id}`}
                  onPress={() => {
                    removeAddress(entry.id);
                  }}
                />
              </View>
            </View>
          );
        })}
      </ScrollView>
      <AddressFormModal
        visible={editing !== null}
        initial={addresses.find((entry) => entry.id === editing) ?? null}
        onSave={(draft) => {
          const editingId = editing === 'new' || editing === null ? undefined : editing;
          const commit = (): void => {
            saveAddress(draft, editingId);
            setEditing(null);
          };
          // The store keeps one Home and one Work: saving another replaces it, so ask first.
          if (tagHolder(addresses, draft.label, editingId) === null) {
            commit();
            return;
          }
          const tag = t(`address.label.${draft.label}`);
          Alert.alert(
            t('addressBook.replaceTitle', { label: tag }),
            t('addressBook.replaceMessage', { label: tag }),
            [
              { text: t('address.cancel'), style: 'cancel' },
              { text: t('addressBook.replace'), style: 'destructive', onPress: commit },
            ],
          );
        }}
        onClose={() => {
          setEditing(null);
        }}
      />
    </SafeAreaView>
  );
}

/** The address book: choose where to deliver, add (Home / Work / Other), edit or remove. */
export function AddressBookModal({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="fullScreen"
      onRequestClose={onClose}
    >
      {visible ? <AddressBook onClose={onClose} /> : null}
    </Modal>
  );
}
