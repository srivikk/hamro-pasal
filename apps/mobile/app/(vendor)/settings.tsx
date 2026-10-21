import Ionicons from '@expo/vector-icons/Ionicons';
import { useMutation } from '@tanstack/react-query';
import { router } from 'expo-router';
import { useState, type ReactNode } from 'react';
import { Alert, Pressable, Switch, Text, TextInput, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { useSignOut } from '../../src/api/auth';
import { ApiError } from '../../src/api/http';
import { DELIVERY_SETTINGS_ERROR_CODES } from '../../src/api/vendor-delivery-settings';
import { deactivateShop, deactivationBlockersOf } from '../../src/api/vendor-account';
import { TAX_IDENTITY_ERROR_CODES } from '../../src/api/vendor-tax-identity';
import { Button } from '../../src/components/Button';
import { KeyboardScreen } from '../../src/components/KeyboardScreen';
import { SearchableSelect } from '../../src/components/SearchableSelect';
import { LanguageToggle } from '../../src/features/settings/LanguageToggle';
import { useWhatsAppOptIn } from '../../src/features/settings/useWhatsAppOptIn';
import { MOCK_PALIKAS } from '../../src/features/vendor/mock-palikas';
import { PanDocumentCard } from '../../src/features/vendor/PanDocumentCard';
import {
  addPalika,
  deliveryRequestOf,
  FULFILLMENT_CHOICES,
  formFromDeliveryResponse,
  formFromSettings,
  sanitizeAmountInput,
  sanitizeTaxIdInput,
  SCOPE_CHOICES,
  TAX_ID_LENGTH,
  validateDeliverySettings,
  type ShopSettingsErrors,
  type ShopSettingsField,
  type ShopSettingsForm,
} from '../../src/features/vendor/shop-settings';
import {
  useDeliverySettingsQuery,
  useSaveDeliverySettings,
} from '../../src/features/vendor/useDeliverySettings';
import { useSaveTaxIdentity, useTaxIdentityQuery } from '../../src/features/vendor/usePanDocument';
import { useSaveShopSettings, useShopSettings } from '../../src/features/vendor/useShopSettings';
import { useToastStore } from '../../src/store/useToastStore';
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
  disabled = false,
  onPress,
}: {
  testID: string;
  label: string;
  hint: string;
  selected: boolean;
  disabled?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      testID={testID}
      accessibilityRole="radio"
      accessibilityState={{ selected, disabled }}
      disabled={disabled}
      onPress={onPress}
      className={`flex-row items-center gap-3 rounded-xl border-2 p-3 ${selected ? 'border-brand bg-brand-light' : 'border-gray-200 bg-white'} ${disabled ? 'opacity-40' : 'opacity-100'}`}
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
 * The tax identity is the server's (Phase 35): the PAN number and the VAT switch are read from
 * `GET /api/vendor/tax-identity` and saved with `PUT` by their own button, and PanDocumentCard
 * uploads the certificate to `POST /api/vendor/tax-identity/document`. A changed PAN number
 * removes the document of the old one on the server, so the vendor is asked first.
 *
 * The delivery settings are the server's too (Phase 36): the form opens on what
 * `GET /api/vendor/delivery-settings` holds, Save sends all seven with `PUT`, and the answer (the
 * shop's own Palika added, names in the list's spelling) is what the form then shows. A mode the
 * Super Admin has switched off cannot be chosen. Save is off until the server's settings have
 * loaded: saving the form's defaults over settings the phone could not read would replace them.
 *
 * The phone keeps a copy of the last saved settings for the dashboard's "add your PAN" reminder.
 */
export default function VendorSettingsScreen() {
  const { t } = useTranslation();
  const saved = useShopSettings();
  const save = useSaveShopSettings();
  const signOut = useSignOut();
  const toast = useToastStore((store) => store.show);
  // Until the vendor changes something the form shows the server's settings (derived, never
  // copied into state: the answer of a save, or a refetch, is on screen at once).
  const delivery = useDeliverySettingsQuery();
  const saveDelivery = useSaveDeliverySettings();
  const [draft, setDraft] = useState<ShopSettingsForm | null>(null);
  const base =
    delivery.data === undefined
      ? formFromSettings(saved)
      : formFromDeliveryResponse(delivery.data, saved?.taxId ?? '');
  const form = draft ?? base;
  const [errors, setErrors] = useState<ShopSettingsErrors>({});
  const platform = delivery.data?.platform;
  const ownPalika = delivery.data?.municipality_palika_string ?? null;

  const update = (patch: Partial<ShopSettingsForm>): void => {
    setDraft((current) => ({ ...(current ?? base), ...patch }));
  };
  /** Switched off by the Super Admin: only the shop already on it keeps it selected. */
  const modeOff = (mode: ShopSettingsForm['fulfillmentMode']): boolean =>
    platform !== undefined &&
    !(mode === 'SELF_DELIVERY' ? platform.self_delivery_enabled : platform.platform_fleet_enabled);

  // The tax identity on file. Until the vendor types, the field and the switch show the server's
  // values (derived, never copied into state: a refetch can only change what was not touched).
  const identity = useTaxIdentityQuery();
  const saveIdentity = useSaveTaxIdentity();
  const [taxIdTouched, setTaxIdTouched] = useState(false);
  const [vatDraft, setVatDraft] = useState<boolean | null>(null);
  const [taxError, setTaxError] = useState(false);
  const onFile = identity.data;
  const taxId = taxIdTouched ? form.taxId : (onFile?.tax_id ?? form.taxId);
  const vatRegistered = vatDraft ?? onFile?.is_vat_registered ?? false;

  const sendTaxIdentity = (): void => {
    saveIdentity.mutate(
      { taxId, isVatRegistered: vatRegistered },
      {
        onSuccess: (result) => {
          // From here on the form follows the server again.
          setTaxIdTouched(false);
          setVatDraft(null);
          // A save never brings the shop online: the verification does (SPEC core 10).
          toast(
            result.pan_document_removed
              ? t('vendorShop.taxSavedDocumentRemoved')
              : result.status === 'SUSPENDED_COMPLIANCE'
                ? t('vendorShop.taxSavedPendingVerification')
                : t('vendorShop.taxSaved'),
            'success',
          );
        },
        onError: (error) => {
          const code = error instanceof ApiError ? error.code : null;
          const invalid = code === TAX_IDENTITY_ERROR_CODES.invalid || code === 'VALIDATION_FAILED';
          setTaxError(invalid);
          toast(
            t(
              invalid
                ? 'vendorShop.taxErrors.invalid'
                : code === 'NETWORK_ERROR'
                  ? 'vendorShop.taxErrors.network'
                  : 'vendorShop.taxErrors.failed',
            ),
            'error',
          );
        },
      },
    );
  };

  const submitTaxIdentity = (): void => {
    if (saveIdentity.isPending) return;
    if (taxId.length !== TAX_ID_LENGTH) {
      setTaxError(true);
      toast(t('vendorShop.taxErrors.invalid'), 'error');
      return;
    }
    setTaxError(false);
    // A different number takes the uploaded document (and its verification) with it.
    const replaces =
      onFile !== undefined &&
      onFile.tax_id !== null &&
      onFile.tax_id !== taxId &&
      (onFile.has_pan_document || onFile.pan_verified_at !== null);
    if (!replaces) {
      sendTaxIdentity();
      return;
    }
    Alert.alert(t('vendorShop.taxChangeTitle'), t('vendorShop.taxChangeBody'), [
      { text: t('vendorMarketing.cancel'), style: 'cancel' },
      { text: t('vendorShop.taxChangeConfirm'), style: 'destructive', onPress: sendTaxIdentity },
    ]);
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

  // Phase 37: closing the shop is the server's (POST /api/vendor/account/deactivate). It decides
  // what stands in the way; the app names each reason so the vendor knows what to settle first.
  const deactivate = useMutation({ mutationFn: deactivateShop, retry: false });
  const deleteShop = (): void => {
    if (deactivate.isPending) return;
    Alert.alert(t('vendorShop.deleteConfirmTitle'), t('vendorShop.deleteConfirmBody'), [
      { text: t('vendorMarketing.cancel'), style: 'cancel' },
      {
        text: t('vendorShop.deleteShop'),
        style: 'destructive',
        onPress: () => {
          deactivate.mutate(undefined, {
            onSuccess: () => {
              toast(t('vendorShop.deleteRequested'), 'success');
              // The account can no longer sign in: nothing is left to do here.
              signOut();
            },
            onError: (error) => {
              const blockers = deactivationBlockersOf(error);
              if (blockers !== null) {
                Alert.alert(
                  t('vendorShop.deleteBlockedTitle'),
                  blockers.map((blocker) => t(`vendorShop.deleteBlocked.${blocker}`)).join('\n'),
                );
                return;
              }
              const offline = error instanceof ApiError && error.code === 'NETWORK_ERROR';
              toast(
                t(offline ? 'vendorShop.deleteErrors.network' : 'vendorShop.deleteErrors.failed'),
                'error',
              );
            },
          });
        },
      },
    ]);
  };

  const submit = (): void => {
    if (saveDelivery.isPending || delivery.data === undefined) return;
    const result = validateDeliverySettings(form);
    if (!result.ok) {
      setErrors(result.errors);
      toast(t('vendorShop.fixErrors'), 'error');
      return;
    }
    setErrors({});
    saveDelivery.mutate(deliveryRequestOf(result.settings), {
      onSuccess: () => {
        // From here on the form follows the server's answer again.
        setDraft(null);
        // The phone's copy needs a PAN (the one on file, or the one being typed).
        if (taxId.length === TAX_ID_LENGTH) save({ taxId, ...result.settings });
        toast(t('vendorShop.saved'), 'success');
      },
      onError: (error) => {
        const code = error instanceof ApiError ? error.code : null;
        toast(
          t(
            code === DELIVERY_SETTINGS_ERROR_CODES.modeDisabled
              ? 'vendorShop.deliveryErrors.modeDisabled'
              : code === DELIVERY_SETTINGS_ERROR_CODES.invalid || code === 'VALIDATION_FAILED'
                ? 'vendorShop.deliveryErrors.invalid'
                : code === 'NETWORK_ERROR'
                  ? 'vendorShop.deliveryErrors.network'
                  : 'vendorShop.deliveryErrors.failed',
          ),
          'error',
        );
      },
    });
  };

  return (
    <KeyboardScreen testID="vendor-settings">
      <Section title={t('vendorShop.taxTitle')}>
        <Field
          testID="settings-tax-id"
          label={t('vendorShop.taxId')}
          hint={t('vendorShop.taxIdHint')}
          value={taxId}
          error={taxError ? t('vendorShop.taxErrors.invalid') : errorOf('taxId')}
          keyboardType="number-pad"
          // Room for a pasted number with separators; the field itself never holds more than nine.
          maxLength={taxId.length >= TAX_ID_LENGTH ? TAX_ID_LENGTH : 20}
          onChangeText={(text) => {
            setTaxIdTouched(true);
            setTaxError(false);
            update({ taxId: sanitizeTaxIdInput(text) });
          }}
        />
        <View className="flex-row items-center gap-3">
          <View className="flex-1">
            <Text className="text-base text-gray-900">{t('vendorShop.vatRegistered')}</Text>
            <Text className="text-sm text-gray-500">{t('vendorShop.vatRegisteredHint')}</Text>
          </View>
          <Switch
            testID="settings-vat-registered"
            accessibilityLabel={t('vendorShop.vatRegistered')}
            value={vatRegistered}
            disabled={saveIdentity.isPending}
            onValueChange={setVatDraft}
            // Switch takes raw colours, not a className.
            trackColor={{ true: colors.success, false: colors.inactive }}
          />
        </View>
        {identity.isError ? (
          <Text className="text-sm text-amber-700" testID="settings-tax-load-error">
            {t('vendorShop.taxLoadError')}
          </Text>
        ) : null}
        <Button
          testID="settings-tax-save"
          label={t(saveIdentity.isPending ? 'vendorShop.taxSaving' : 'vendorShop.taxSave')}
          disabled={saveIdentity.isPending}
          onPress={submitTaxIdentity}
        />
        <PanDocumentCard />
      </Section>

      <Section title={t('vendorShop.modeTitle')}>
        {delivery.isError ? (
          <View className="gap-2" testID="settings-delivery-error">
            <Text className="text-sm text-red-700">{t('vendorShop.deliveryLoadError')}</Text>
            <Button
              testID="settings-delivery-retry"
              label={t('vendorShop.deliveryRetry')}
              variant="secondary"
              size="sm"
              onPress={() => {
                void delivery.refetch();
              }}
            />
          </View>
        ) : delivery.data === undefined ? (
          <Text className="text-sm text-gray-500" testID="settings-delivery-loading">
            {t('vendorShop.deliveryLoading')}
          </Text>
        ) : null}
        {delivery.data?.fulfillment_mode_enabled === false ? (
          <Text className="text-sm font-semibold text-red-700" testID="settings-forced-offline">
            {t('vendorShop.forcedOffline')}
          </Text>
        ) : null}
        {FULFILLMENT_CHOICES.map((mode) => (
          <Option
            key={mode}
            testID={`settings-mode-${mode}`}
            label={t(`vendorShop.mode.${mode}`)}
            hint={modeOff(mode) ? t('vendorShop.modeOff') : t(`vendorShop.modeHint.${mode}`)}
            selected={form.fulfillmentMode === mode}
            // The server refuses a switched-off mode unless the shop is already on it.
            disabled={modeOff(mode) && delivery.data?.fulfillment_mode !== mode}
            onPress={() => {
              update({ fulfillmentMode: mode });
            }}
          />
        ))}
        {!selfDelivery && platform !== undefined ? (
          <Text className="text-sm text-gray-500" testID="settings-platform-fee">
            {t('vendorShop.platformFee', { amount: platform.platform_delivery_fee_npr })}
          </Text>
        ) : null}
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
                <Text className="flex-1 text-base text-gray-900">
                  {palika === ownPalika ? t('vendorShop.ownPalika', { name: palika }) : palika}
                </Text>
                {/* The shop's own municipality is always served: the server keeps it listed. */}
                {palika === ownPalika ? null : (
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
                )}
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

      <Section title={t('vendorShop.minOrderTitle')}>
        <Field
          testID="settings-min-order"
          label={t('vendorShop.minOrder')}
          hint={t('vendorShop.minOrderHint')}
          value={form.minOrder}
          error={errorOf('minOrder')}
          onChangeText={(text) => {
            update({ minOrder: sanitizeAmountInput(text) });
          }}
        />
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

      <Button
        testID="settings-save"
        label={t(saveDelivery.isPending ? 'vendorShop.taxSaving' : 'vendorShop.save')}
        disabled={saveDelivery.isPending || delivery.data === undefined}
        onPress={submit}
      />

      <Section title={t('vendorShop.paymentsTitle')}>
        <Text className="text-sm text-gray-500">{t('vendorShop.paymentsHint')}</Text>
        <Button
          testID="settings-payments"
          label={t('vendorShop.paymentsOpen')}
          variant="secondary"
          onPress={() => {
            router.push('/payments');
          }}
        />
      </Section>

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
        <Text className="text-sm text-gray-500">{t('vendorShop.deleteHint')}</Text>
        <Button
          testID="settings-delete-shop"
          label={t(deactivate.isPending ? 'vendorShop.deleting' : 'vendorShop.deleteShop')}
          variant="destructive"
          disabled={deactivate.isPending}
          onPress={deleteShop}
        />
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
