import Ionicons from '@expo/vector-icons/Ionicons';
import { useState, type ReactNode } from 'react';
import { Alert, Pressable, Switch, Text, TextInput, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { useSignOut } from '../../src/api/auth';
import { Button } from '../../src/components/Button';
import { KeyboardScreen } from '../../src/components/KeyboardScreen';
import { SearchableSelect } from '../../src/components/SearchableSelect';
import { LanguageToggle } from '../../src/features/settings/LanguageToggle';
import { useWhatsAppOptIn } from '../../src/features/settings/useWhatsAppOptIn';
import { formatNepalDateTime } from '../../src/features/vendor/invoice-math';
import { MOCK_PALIKAS } from '../../src/features/vendor/mock-palikas';
import { PanDocumentCard } from '../../src/features/vendor/PanDocumentCard';
import { useShopDeletionCheck } from '../../src/features/vendor/shop-deletion';
import {
  addPalika,
  FULFILLMENT_CHOICES,
  formFromSettings,
  sanitizeAmountInput,
  sanitizeTaxIdInput,
  SCOPE_CHOICES,
  TAX_ID_LENGTH,
  validateShopSettings,
  type ShopSettingsErrors,
  type ShopSettingsField,
  type ShopSettingsForm,
} from '../../src/features/vendor/shop-settings';
import { useSaveShopSettings, useShopSettings } from '../../src/features/vendor/useShopSettings';
import { useAuthStore } from '../../src/store/useAuthStore';
import { selectSessionUserId } from '../../src/store/useProfileStore';
import { useToastStore } from '../../src/store/useToastStore';
import { useVendorShopStore } from '../../src/store/useVendorShopStore';
import { colors } from '../../src/theme/colors';

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View className="gap-3 rounded-2xl bg-white p-4 shadow-sm">
      <Text className="text-lg font-bold text-gray-900">{title}</Text>
      {children}
    </View>
  );
}

/** One choice of a single-select group: a row with a radio mark. */
function Option({
  testID,
  label,
  hint,
  selected,
  onPress,
}: {
  testID: string;
  label: string;
  hint: string;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      testID={testID}
      accessibilityRole="radio"
      accessibilityState={{ selected }}
      onPress={onPress}
      className={`flex-row items-center gap-3 rounded-xl border-2 p-3 ${selected ? 'border-brand bg-brand-light' : 'border-gray-200 bg-white'}`}
    >
      <Ionicons
        name={selected ? 'radio-button-on' : 'radio-button-off'}
        size={22}
        color={selected ? colors.brand : colors.inactive}
      />
      <View className="flex-1">
        <Text className="text-base font-semibold text-gray-900">{label}</Text>
        <Text className="text-sm text-gray-500">{hint}</Text>
      </View>
    </Pressable>
  );
}

function Field({
  testID,
  label,
  hint,
  value,
  error,
  onChangeText,
  keyboardType = 'decimal-pad',
  maxLength,
}: {
  testID: string;
  label: string;
  hint?: string | undefined;
  value: string;
  error?: string | undefined;
  onChangeText: (text: string) => void;
  keyboardType?: 'decimal-pad' | 'number-pad';
  maxLength?: number;
}) {
  return (
    <View className="gap-1">
      <Text className="text-sm font-semibold text-gray-700">{label}</Text>
      <TextInput
        testID={testID}
        accessibilityLabel={label}
        value={value}
        onChangeText={onChangeText}
        keyboardType={keyboardType}
        maxLength={maxLength}
        className={`min-h-12 rounded-xl border bg-white px-4 text-base text-gray-900 ${error === undefined ? 'border-gray-300' : 'border-red-500'}`}
      />
      {error === undefined ? (
        hint === undefined ? null : (
          <Text className="text-sm text-gray-500">{hint}</Text>
        )
      ) : (
        <Text className="text-sm text-red-700" testID={`${testID}-error`}>
          {error}
        </Text>
      )}
    </View>
  );
}

/**
 * Vendor flow step 14 and SPEC Fiscal Invoicing: the shop's PAN, its delivery mode, the scope tier
 * it serves and, for its own delivery, what it charges; then the account's own preferences
 * (language, WhatsApp updates) and the request to delete the shop account. Opened from the gear in the Vendor App
 * header.
 *
 * The PAN document (Phase 34) is the one part that goes to the server: PanDocumentCard uploads it
 * to `POST /api/vendor/tax-identity/document` and reads its standing back.
 *
 * TODO: send the rest (`PUT /api/vendor/tax-identity` for the PAN number itself,
 * `PUT /api/vendor/delivery-settings`; both routes exist). Until then the form below is saved on
 * the phone only.
 */
export default function VendorSettingsScreen() {
  const { t } = useTranslation();
  const saved = useShopSettings();
  const save = useSaveShopSettings();
  const signOut = useSignOut();
  const toast = useToastStore((store) => store.show);
  const [form, setForm] = useState<ShopSettingsForm>(() => formFromSettings(saved));
  const [errors, setErrors] = useState<ShopSettingsErrors>({});

  const update = (patch: Partial<ShopSettingsForm>): void => {
    setForm((current) => ({ ...current, ...patch }));
  };
  const errorOf = (field: ShopSettingsField): string | undefined => {
    const error = errors[field];
    return error === undefined ? undefined : t(`vendorShop.errors.${error}`);
  };
  const selfDelivery = form.fulfillmentMode === 'SELF_DELIVERY';

  // Municipalities are picked from the list, never typed: routing matches the names exactly.
  const palikaOptions = MOCK_PALIKAS.filter((palika) => !form.palikas.includes(palika)).map(
    (palika) => ({ value: palika, label: palika }),
  );

  const whatsApp = useWhatsAppOptIn();
  const userId = useAuthStore(selectSessionUserId);
  const deletionBlockers = useShopDeletionCheck();
  const deletionRequest = useVendorShopStore((state) =>
    state.deletionRequest?.userId === userId ? state.deletionRequest : null,
  );

  // TODO: `GET /api/vendor/deletion-eligibility` and `POST /api/vendor/deletion-request`
  // (STATE_HANDOFF.md §8Z.14). Until they exist the check uses what the phone knows and the
  // request is only recorded here: nothing is deleted on the server.
  const deleteShop = (): void => {
    const blockers = deletionBlockers();
    if (blockers.length > 0) {
      Alert.alert(
        t('vendorShop.deleteBlockedTitle'),
        blockers.map((blocker) => t(`vendorShop.deleteBlocked.${blocker}`)).join('\n'),
      );
      return;
    }
    Alert.alert(t('vendorShop.deleteConfirmTitle'), t('vendorShop.deleteConfirmBody'), [
      { text: t('vendorMarketing.cancel'), style: 'cancel' },
      {
        text: t('vendorShop.deleteShop'),
        style: 'destructive',
        onPress: () => {
          useVendorShopStore.getState().requestDeletion(userId, Date.now());
          toast(t('vendorShop.deleteRequested'), 'success');
        },
      },
    ]);
  };

  const submit = (): void => {
    const result = validateShopSettings(form);
    if (!result.ok) {
      setErrors(result.errors);
      toast(t('vendorShop.fixErrors'), 'error');
      return;
    }
    setErrors({});
    save(result.settings);
    setForm(formFromSettings(result.settings));
    toast(t('vendorShop.saved'), 'success');
  };

  return (
    <KeyboardScreen testID="vendor-settings">
      <Section title={t('vendorShop.taxTitle')}>
        <Field
          testID="settings-tax-id"
          label={t('vendorShop.taxId')}
          hint={t('vendorShop.taxIdHint')}
          value={form.taxId}
          error={errorOf('taxId')}
          keyboardType="number-pad"
          // Room for a pasted number with separators; the field itself never holds more than nine.
          maxLength={form.taxId.length >= TAX_ID_LENGTH ? TAX_ID_LENGTH : 20}
          onChangeText={(text) => {
            update({ taxId: sanitizeTaxIdInput(text) });
          }}
        />
        <PanDocumentCard />
      </Section>

      <Section title={t('vendorShop.modeTitle')}>
        {FULFILLMENT_CHOICES.map((mode) => (
          <Option
            key={mode}
            testID={`settings-mode-${mode}`}
            label={t(`vendorShop.mode.${mode}`)}
            hint={t(`vendorShop.modeHint.${mode}`)}
            selected={form.fulfillmentMode === mode}
            onPress={() => {
              update({ fulfillmentMode: mode });
            }}
          />
        ))}
      </Section>

      <Section title={t('vendorShop.scopeTitle')}>
        {SCOPE_CHOICES.map((scope) => (
          <Option
            key={scope}
            testID={`settings-scope-${scope}`}
            label={t(`vendorShop.scope.${scope}`)}
            hint={t(`vendorShop.scopeHint.${scope}`)}
            selected={form.deliveryScope === scope}
            onPress={() => {
              update({ deliveryScope: scope });
            }}
          />
        ))}

        {form.deliveryScope === 'RADIUS_BOUND' ? (
          <Field
            testID="settings-radius"
            label={t('vendorShop.radius')}
            value={form.radiusKm}
            error={errorOf('radiusKm')}
            onChangeText={(text) => {
              update({ radiusKm: sanitizeAmountInput(text) });
            }}
          />
        ) : null}

        {form.deliveryScope === 'CITY_WIDE' ? (
          <View className="gap-2">
            <Text className="text-sm font-semibold text-gray-700">{t('vendorShop.palikas')}</Text>
            <SearchableSelect
              testID="settings-palika"
              options={palikaOptions}
              placeholder={t('vendorShop.palikaAdd')}
              searchPlaceholder={t('vendorShop.palikaSearch')}
              emptyText={t('vendorShop.palikaNone')}
              invalid={errors.palikas !== undefined}
              onSelect={(palika) => {
                update({ palikas: addPalika(form.palikas, palika) });
              }}
            />
            {form.palikas.map((palika) => (
              <View
                key={palika}
                className="flex-row items-center justify-between rounded-xl bg-gray-100 px-3 py-2"
              >
                <Text className="flex-1 text-base text-gray-900">{palika}</Text>
                <Pressable
                  testID={`settings-palika-remove-${palika}`}
                  accessibilityRole="button"
                  accessibilityLabel={t('vendorShop.palikaRemove', { name: palika })}
                  hitSlop={8}
                  onPress={() => {
                    update({ palikas: form.palikas.filter((each) => each !== palika) });
                  }}
                >
                  <Ionicons name="close-circle" size={22} color={colors.inactive} />
                </Pressable>
              </View>
            ))}
            {errors.palikas === undefined ? null : (
              <Text className="text-sm text-red-700" testID="settings-palikas-error">
                {errorOf('palikas')}
              </Text>
            )}
          </View>
        ) : null}
      </Section>

      {selfDelivery ? (
        <Section title={t('vendorShop.chargesTitle')}>
          <Field
            testID="settings-base-fee"
            label={t('vendorShop.baseFee')}
            value={form.baseFee}
            error={errorOf('baseFee')}
            onChangeText={(text) => {
              update({ baseFee: sanitizeAmountInput(text) });
            }}
          />
          <Field
            testID="settings-per-km-fee"
            label={t('vendorShop.perKmFee')}
            hint={t('vendorShop.perKmFeeHint')}
            value={form.perKmFee}
            error={errorOf('perKmFee')}
            onChangeText={(text) => {
              update({ perKmFee: sanitizeAmountInput(text) });
            }}
          />
          <Field
            testID="settings-free-above"
            label={t('vendorShop.freeAbove')}
            hint={t('vendorShop.freeAboveHint')}
            value={form.freeAbove}
            error={errorOf('freeAbove')}
            onChangeText={(text) => {
              update({ freeAbove: sanitizeAmountInput(text) });
            }}
          />
        </Section>
      ) : null}

      <Button testID="settings-save" label={t('vendorShop.save')} onPress={submit} />
      <Text className="text-center text-sm text-gray-500">{t('vendorShop.localOnly')}</Text>

      <Section title={t('vendorShop.preferencesTitle')}>
        <View className="flex-row items-center justify-between gap-3">
          <Text className="flex-1 text-base text-gray-900">{t('settings.language')}</Text>
          <LanguageToggle />
        </View>
        <View className="flex-row items-center gap-3">
          <View className="flex-1">
            <Text className="text-base text-gray-900">{t('notificationPrefs.whatsapp')}</Text>
            <Text className="text-sm text-gray-500">{t('vendorShop.whatsappHint')}</Text>
          </View>
          <Switch
            testID="settings-whatsapp"
            accessibilityLabel={t('notificationPrefs.whatsapp')}
            value={whatsApp.optedIn}
            disabled={whatsApp.pending}
            onValueChange={whatsApp.change}
            // Switch takes raw colours, not a className.
            trackColor={{ true: colors.success, false: colors.inactive }}
          />
        </View>
      </Section>

      <Section title={t('vendorShop.privacyTitle')}>
        {deletionRequest === null ? (
          <>
            <Text className="text-sm text-gray-500">{t('vendorShop.deleteHint')}</Text>
            <Button
              testID="settings-delete-shop"
              label={t('vendorShop.deleteShop')}
              variant="destructive"
              onPress={deleteShop}
            />
          </>
        ) : (
          <>
            <Text
              className="text-base font-semibold text-red-700"
              testID="settings-deletion-pending"
            >
              {t('vendorShop.deletePending', {
                date: formatNepalDateTime(deletionRequest.requestedAt).slice(0, 10),
              })}
            </Text>
            <Text className="text-sm text-gray-500">{t('vendorShop.deletePendingNote')}</Text>
            <Button
              testID="settings-delete-cancel"
              label={t('vendorShop.deleteCancel')}
              variant="secondary"
              onPress={() => {
                useVendorShopStore.getState().cancelDeletion();
                toast(t('vendorShop.deleteCancelled'), 'success');
              }}
            />
          </>
        )}
      </Section>

      <Button
        testID="settings-sign-out"
        label={t('auth.signOut')}
        variant="secondary"
        onPress={signOut}
      />
    </KeyboardScreen>
  );
}
