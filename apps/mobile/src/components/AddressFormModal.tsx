import {
  NEPAL_PROVINCES,
  type NepalAddress,
  type NepalProvinceId,
} from '@hamro-pasal/shared-types';
import { useState } from 'react';
import { Modal, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { SafeAreaView } from 'react-native-safe-area-context';

import {
  addressToFormValues,
  districtsForProvince,
  EMPTY_ADDRESS_FORM,
  validateAddressForm,
  type AddressField,
  type AddressFormValues,
} from '../features/address/address-form';
import { currentPinPosition } from '../features/territory/device-territory';
import type { Coordinates } from '../features/territory/territory';
import { formatLocalizedNumber } from '../i18n/format-number';
import { useAuthStore } from '../store/useAuthStore';
import { Button } from './Button';

export interface AddressFormModalProps {
  visible: boolean;
  /** Pre-fills the form (editing the saved address). */
  initial: NepalAddress | null;
  /** Receives only schema-valid, canonical addresses. */
  onSave: (address: NepalAddress) => void;
  onClose: () => void;
  /** Source for the pin; defaults to the device position (or the __DEV__ location simulator). */
  locatePin?: () => Promise<Coordinates | null>;
}

/** Literal keys, so every province name is checked against the locale files at compile time. */
const PROVINCE_NAME_KEY = {
  1: 'provinces.1',
  2: 'provinces.2',
  3: 'provinces.3',
  4: 'provinces.4',
  5: 'provinces.5',
  6: 'provinces.6',
  7: 'provinces.7',
} as const satisfies Record<NepalProvinceId, string>;

function FieldError({
  field,
  errors,
}: {
  field: AddressField;
  errors: Partial<Record<AddressField, string>>;
}) {
  const { t } = useTranslation();
  if (errors[field] === undefined) return null;
  return (
    <Text className="mt-1 text-sm text-red-700" testID={`address-error-${field}`}>
      {t(`address.errors.${field}`)}
    </Text>
  );
}

function Label({ children }: { children: string }) {
  return <Text className="mb-1 text-sm font-semibold text-neutral-700">{children}</Text>;
}

/** A tap-to-expand list: the dropdown for province and the cascading district list. */
function SelectField({
  label,
  value,
  placeholder,
  options,
  disabled = false,
  onSelect,
  testID,
}: {
  label: string;
  value: string | null;
  placeholder: string;
  options: readonly { value: string; label: string }[];
  disabled?: boolean;
  onSelect: (value: string) => void;
  testID: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <View>
      <Label>{label}</Label>
      <Pressable
        testID={testID}
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={{ disabled, expanded: open }}
        disabled={disabled}
        onPress={() => {
          setOpen((current) => !current);
        }}
        className={`rounded-xl border border-neutral-300 px-3 py-3 ${disabled ? 'bg-neutral-100' : 'bg-white'}`}
      >
        <Text className={value === null ? 'text-neutral-400' : 'text-neutral-900'}>
          {value ?? placeholder}
        </Text>
      </Pressable>
      {open ? (
        <View
          className="mt-1 rounded-xl border border-neutral-200 bg-white"
          accessibilityRole="list"
        >
          {options.map((option) => (
            <Pressable
              key={option.value}
              accessibilityRole="button"
              className="border-b border-neutral-100 px-3 py-3 active:bg-neutral-50"
              onPress={() => {
                onSelect(option.value);
                setOpen(false);
              }}
            >
              <Text className="text-neutral-900">{option.label}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}
    </View>
  );
}

function TextField({
  label,
  value,
  onChangeText,
  numeric = false,
  testID,
}: {
  label: string;
  value: string;
  onChangeText: (value: string) => void;
  numeric?: boolean;
  testID: string;
}) {
  return (
    <View>
      <Label>{label}</Label>
      <TextInput
        testID={testID}
        accessibilityLabel={label}
        value={value}
        onChangeText={onChangeText}
        keyboardType={numeric ? 'number-pad' : 'default'}
        autoCorrect={false}
        className="rounded-xl border border-neutral-300 bg-white px-3 py-3 text-neutral-900"
      />
    </View>
  );
}

function AddressForm({
  initial,
  onSave,
  onClose,
  locatePin,
}: Omit<AddressFormModalProps, 'visible'>) {
  const { t } = useTranslation();
  const locale = useAuthStore((state) => state.locale);
  const [values, setValues] = useState<AddressFormValues>(
    initial === null ? EMPTY_ADDRESS_FORM : addressToFormValues(initial),
  );
  const [errors, setErrors] = useState<Partial<Record<AddressField, string>>>({});
  const [locating, setLocating] = useState(false);
  const [pinFailed, setPinFailed] = useState(false);

  const update = (patch: Partial<AddressFormValues>): void => {
    setValues((current) => ({ ...current, ...patch }));
  };

  const provinceOptions = NEPAL_PROVINCES.map((province) => ({
    value: String(province.id),
    label: `${formatLocalizedNumber(province.id, locale)}. ${t(PROVINCE_NAME_KEY[province.id])}`,
  }));
  const districtOptions = districtsForProvince(values.provinceId).map((district) => ({
    value: district,
    label: district,
  }));
  const selectedProvince = NEPAL_PROVINCES.find((province) => province.id === values.provinceId);

  const dropPin = async (): Promise<void> => {
    setLocating(true);
    setPinFailed(false);
    const position = await (locatePin ?? currentPinPosition)().catch(() => null);
    setLocating(false);
    if (position === null) setPinFailed(true);
    else update({ pin: position });
  };

  const save = (): void => {
    const result = validateAddressForm(values);
    if (result.ok) {
      setErrors({});
      onSave(result.address);
    } else {
      setErrors(result.errors);
    }
  };

  return (
    <SafeAreaView className="flex-1 bg-neutral-50">
      <View className="flex-row items-center justify-between border-b border-neutral-200 bg-white px-4 py-3">
        <Text className="text-lg font-bold text-neutral-900">{t('address.title')}</Text>
        <Button label={t('address.cancel')} size="sm" variant="secondary" onPress={onClose} />
      </View>
      <ScrollView
        contentContainerStyle={{ padding: 16, gap: 16 }}
        keyboardShouldPersistTaps="handled"
      >
        <View>
          <SelectField
            testID="address-province"
            label={t('address.province')}
            placeholder={t('address.select')}
            value={
              selectedProvince === undefined
                ? null
                : `${formatLocalizedNumber(selectedProvince.id, locale)}. ${t(PROVINCE_NAME_KEY[selectedProvince.id])}`
            }
            options={provinceOptions}
            onSelect={(value) => {
              const provinceId = Number(value);
              // Changing province invalidates the district: the cascade starts over.
              update({
                provinceId,
                district: provinceId === values.provinceId ? values.district : null,
              });
            }}
          />
          <FieldError field="province_id" errors={errors} />
        </View>

        <View>
          <SelectField
            testID="address-district"
            label={t('address.district')}
            placeholder={
              values.provinceId === null ? t('address.selectProvinceFirst') : t('address.select')
            }
            value={values.district}
            options={districtOptions}
            disabled={values.provinceId === null}
            onSelect={(district) => {
              update({ district });
            }}
          />
          <FieldError field="district_string" errors={errors} />
        </View>

        <View>
          <TextField
            testID="address-palika"
            label={t('address.palika')}
            value={values.palika}
            onChangeText={(palika) => {
              update({ palika });
            }}
          />
          <FieldError field="municipality_palika_string" errors={errors} />
        </View>

        <View>
          <TextField
            testID="address-ward"
            label={t('address.ward')}
            value={values.ward}
            numeric
            onChangeText={(ward) => {
              update({ ward });
            }}
          />
          <FieldError field="ward_number" errors={errors} />
        </View>

        <View>
          <TextField
            testID="address-tole"
            label={t('address.tole')}
            value={values.tole}
            onChangeText={(tole) => {
              update({ tole });
            }}
          />
          <FieldError field="tole_locality" errors={errors} />
        </View>

        <View>
          <TextField
            testID="address-landmark"
            label={t('address.landmark')}
            value={values.landmark}
            onChangeText={(landmark) => {
              update({ landmark });
            }}
          />
          <FieldError field="landmark" errors={errors} />
        </View>

        {/* STUB: a map "Drop a Pin" (Mapbox / Google Maps, SPEC §3) replaces this in a later phase. */}
        <View
          className="gap-2 rounded-2xl border border-neutral-200 bg-white p-4"
          testID="address-pin"
        >
          <Label>{t('address.pin.title')}</Label>
          <Text className="text-sm text-neutral-900" testID="address-pin-value">
            {values.pin === null
              ? t('address.pin.none')
              : t('address.pin.coords', {
                  lat: formatLocalizedNumber(Number(values.pin.latitude.toFixed(5)), locale),
                  lng: formatLocalizedNumber(Number(values.pin.longitude.toFixed(5)), locale),
                })}
          </Text>
          <Text className="text-xs text-neutral-500">{t('address.pin.stub')}</Text>
          <Button
            label={locating ? t('address.pin.locating') : t('address.pin.use')}
            size="sm"
            variant="secondary"
            disabled={locating}
            onPress={() => void dropPin()}
          />
          {pinFailed ? (
            <Text className="text-sm text-red-700">{t('address.pin.failed')}</Text>
          ) : null}
          <FieldError field="pin" errors={errors} />
        </View>

        <Button label={t('address.save')} onPress={save} />
      </ScrollView>
    </SafeAreaView>
  );
}

/** SPEC Nepal localizations §3: Province → District → Palika → Ward → Tole, landmark and pin. */
export function AddressFormModal({ visible, ...props }: AddressFormModalProps) {
  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="fullScreen"
      onRequestClose={props.onClose}
    >
      {/* Mounted per opening, so each visit starts from the saved address. */}
      {visible ? <AddressForm {...props} /> : null}
    </Modal>
  );
}
