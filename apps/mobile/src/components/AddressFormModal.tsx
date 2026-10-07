import { NEPAL_PROVINCES, type NepalProvinceId } from '@hamro-pasal/shared-types';
import { useRef, useState } from 'react';
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from 'react-native';
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
import { geocodeArea } from '../features/location/place-search';
import { usePlaceName } from '../features/location/usePlaceName';
import { currentPinPosition } from '../features/territory/device-territory';
import type { Coordinates } from '../features/territory/territory';
import { formatLocalizedNumber } from '../i18n/format-number';
import { useKeyboardHeight } from '../lib/useKeyboardHeight';
import {
  ADDRESS_LABELS,
  MAX_RECIPIENT_NAME_LENGTH,
  type AddressDraft,
} from '../store/useAddressStore';
import { useAuthStore } from '../store/useAuthStore';
import { Button } from './Button';
import { MapPinPicker } from './MapPinPicker';

/** How long after a field takes focus it is scrolled into sight (the keyboard is up by then). */
const FOCUS_SCROLL_DELAY_MS = 300;

export interface AddressFormModalProps {
  visible: boolean;
  /** Pre-fills the form (editing a saved address). */
  initial: AddressDraft | null;
  /** Receives only schema-valid, canonical addresses, with their label and recipient. */
  onSave: (draft: AddressDraft) => void;
  onClose: () => void;
  /** Source for the pin; defaults to the device position (or the __DEV__ location simulator). */
  locatePin?: () => Promise<Coordinates | null>;
  /** Finds where a typed area is, to open the map there; defaults to the place search. */
  locateArea?: (query: string) => Promise<Coordinates | null>;
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
  return <Text className="mb-1 text-sm font-semibold text-gray-700">{children}</Text>;
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
        className={`rounded-xl border border-gray-300 px-3 py-3 ${disabled ? 'bg-gray-100' : 'bg-white'}`}
      >
        <Text className={value === null ? 'text-gray-400' : 'text-gray-900'}>
          {value ?? placeholder}
        </Text>
      </Pressable>
      {open ? (
        <View className="mt-1 rounded-xl bg-white shadow-sm" accessibilityRole="list">
          {options.map((option) => (
            <Pressable
              key={option.value}
              accessibilityRole="button"
              className="border-b border-gray-100 px-3 py-3 active:bg-gray-50"
              onPress={() => {
                onSelect(option.value);
                setOpen(false);
              }}
            >
              <Text className="text-gray-900">{option.label}</Text>
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
  maxLength,
  testID,
  onFocused,
}: {
  label: string;
  value: string;
  onChangeText: (value: string) => void;
  numeric?: boolean;
  maxLength?: number;
  testID: string;
  /** Called with the field's own view when it takes focus, so the form can scroll it into sight. */
  onFocused?: (field: View) => void;
}) {
  const field = useRef<View>(null);
  return (
    <View ref={field} collapsable={false}>
      <Label>{label}</Label>
      <TextInput
        testID={testID}
        onFocus={() => {
          if (field.current !== null) onFocused?.(field.current);
        }}
        accessibilityLabel={label}
        value={value}
        onChangeText={onChangeText}
        keyboardType={numeric ? 'number-pad' : 'default'}
        maxLength={maxLength}
        autoCorrect={false}
        className="rounded-xl border border-gray-300 bg-white px-3 py-3 text-gray-900"
      />
    </View>
  );
}

function AddressForm({
  initial,
  onSave,
  onClose,
  locatePin,
  locateArea,
}: Omit<AddressFormModalProps, 'visible'>) {
  const { t } = useTranslation();
  const locale = useAuthStore((state) => state.locale);
  const [values, setValues] = useState<AddressFormValues>(
    initial === null
      ? EMPTY_ADDRESS_FORM
      : addressToFormValues(initial.address, initial.label, initial.recipient),
  );
  const [mapOpen, setMapOpen] = useState(false);
  const [mapCenter, setMapCenter] = useState<Coordinates | null>(null);
  const [centering, setCentering] = useState(false);
  const keyboardHeight = useKeyboardHeight();
  const scroll = useRef<ScrollView>(null);
  const content = useRef<View>(null);

  // Once the keyboard is up (and, on Android, the padding below it exists), bring the focused
  // field to the top of what is visible.
  const revealField = (field: View): void => {
    setTimeout(() => {
      if (content.current === null) return;
      field.measureLayout(
        content.current,
        (_x, y) => {
          scroll.current?.scrollTo({ y: Math.max(0, y - 24), animated: true });
        },
        () => undefined,
      );
    }, FOCUS_SCROLL_DELAY_MS);
  };

  // The map opens on the pin if there is one; else on the Palika / district already typed (so a
  // customer filling in Pokhara is not shown Kathmandu); else on its default.
  const openMap = async (): Promise<void> => {
    let center = values.pin;
    if (center === null) {
      const area = [values.palika.trim(), values.district ?? ''].filter((part) => part !== '');
      if (area.length > 0) {
        setCentering(true);
        center = await (locateArea ?? geocodeArea)(area.join(', ')).catch(() => null);
        setCentering(false);
      }
    }
    setMapCenter(center);
    setMapOpen(true);
  };
  const pinPlace = usePlaceName(values.pin);
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
      onSave({ label: result.label, recipient: result.recipient, address: result.address });
    } else {
      setErrors(result.errors);
    }
  };

  return (
    <SafeAreaView className="flex-1 bg-gray-50">
      <View className="flex-row items-center justify-between border-b border-gray-200 bg-white px-4 py-3">
        <Text className="text-lg font-bold text-gray-900">{t('address.title')}</Text>
        <Button label={t('address.cancel')} size="sm" variant="secondary" onPress={onClose} />
      </View>
      {/* The keyboard must never cover the field being typed in. iOS: the form is padded above
          it. Android: a Modal is not resized for the keyboard and KeyboardAvoidingView does not
          help, so the scroll content gets the keyboard's height as bottom padding. On both, the
          focused field is then scrolled into sight. */}
      <KeyboardAvoidingView
        className="flex-1"
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        testID="address-form-keyboard"
      >
        <ScrollView
          className="flex-1"
          ref={scroll}
          testID="address-form-scroll"
          contentContainerStyle={{
            padding: 16,
            paddingBottom: 48 + (Platform.OS === 'android' ? keyboardHeight : 0),
          }}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          showsVerticalScrollIndicator={false}
        >
          <View ref={content} collapsable={false} style={{ gap: 16 }}>
            <View>
              <Label>{t('address.label.title')}</Label>
              <View className="flex-row gap-2" accessibilityRole="radiogroup">
                {ADDRESS_LABELS.map((label) => (
                  <View key={label} className="flex-1">
                    <Button
                      label={t(`address.label.${label}`)}
                      size="sm"
                      variant={values.label === label ? 'primary' : 'secondary'}
                      testID={`address-label-${label}`}
                      onPress={() => {
                        update({ label });
                      }}
                    />
                  </View>
                ))}
              </View>
            </View>

            {/* Ordering for someone else: the rider needs to know who to hand the order to. */}
            {values.label === 'OTHER' ? (
              <View className="gap-4 rounded-2xl bg-white shadow-sm p-4">
                <Text className="text-xs text-gray-500">{t('address.recipient.hint')}</Text>
                <View>
                  <TextField
                    onFocused={revealField}
                    testID="address-recipient-name"
                    label={t('address.recipient.name')}
                    value={values.recipientName}
                    maxLength={MAX_RECIPIENT_NAME_LENGTH}
                    onChangeText={(recipientName) => {
                      update({ recipientName });
                    }}
                  />
                  <FieldError field="recipient_name" errors={errors} />
                </View>
                <View>
                  <TextField
                    onFocused={revealField}
                    testID="address-recipient-phone"
                    label={t('address.recipient.phone')}
                    value={values.recipientPhone}
                    numeric
                    maxLength={16}
                    onChangeText={(recipientPhone) => {
                      update({ recipientPhone });
                    }}
                  />
                  <FieldError field="recipient_phone" errors={errors} />
                </View>
              </View>
            ) : null}

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
                  values.provinceId === null
                    ? t('address.selectProvinceFirst')
                    : t('address.select')
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
                onFocused={revealField}
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
                onFocused={revealField}
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
                onFocused={revealField}
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
                onFocused={revealField}
                testID="address-landmark"
                label={t('address.landmark')}
                value={values.landmark}
                onChangeText={(landmark) => {
                  update({ landmark });
                }}
              />
              <FieldError field="landmark" errors={errors} />
            </View>

            {/* SPEC §3 "Drop a Pin": on the map, or from the device's current position. */}
            <View className="gap-2 rounded-2xl bg-white shadow-sm p-4" testID="address-pin">
              <Label>{t('address.pin.title')}</Label>
              {/* The pinned place by name; latitude and longitude are never shown. */}
              <Text className="text-sm text-gray-900" numberOfLines={2} testID="address-pin-value">
                {values.pin === null
                  ? t('address.pin.none')
                  : (pinPlace.name ?? t('address.pin.set'))}
              </Text>
              <Button
                label={centering ? t('address.pin.locating') : t('address.pin.map')}
                size="sm"
                testID="address-pin-map"
                disabled={centering}
                onPress={() => void openMap()}
              />
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
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
      <MapPinPicker
        visible={mapOpen}
        initial={mapCenter}
        onConfirm={(pin) => {
          update({ pin });
          setPinFailed(false);
          setMapOpen(false);
        }}
        onClose={() => {
          setMapOpen(false);
        }}
      />
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
