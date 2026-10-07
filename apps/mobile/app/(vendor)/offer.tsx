import { router } from 'expo-router';
import { useState } from 'react';
import { Text, TextInput, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { Button } from '../../src/components/Button';
import { KeyboardScreen } from '../../src/components/KeyboardScreen';
import { SegmentedControl } from '../../src/components/SegmentedControl';
import {
  DISCOUNT_KINDS,
  EMPTY_OFFER_FORM,
  sanitizeOfferInput,
  validateOfferForm,
  type OfferField,
  type OfferForm,
  type OfferFormErrors,
} from '../../src/features/vendor/marketing-rules';
import { useToastStore } from '../../src/store/useToastStore';
import { useVendorMarketingStore } from '../../src/store/useVendorMarketingStore';

/**
 * A new vendor-funded offer (SPEC Discounts, "Vendor Offers"): the discount type, its amount and
 * the minimum order it needs. Opened from Marketing → My Offers. An offer is never edited
 * afterwards, only ended, so every order can point at the exact rule it was priced with.
 *
 * TODO: `POST /api/vendor/offers` (BACKEND_CHECKLIST.md section 5 step 2). Until then the offer is
 * kept on the device and changes no price.
 */
export default function VendorOfferScreen() {
  const { t } = useTranslation();
  const createOffer = useVendorMarketingStore((state) => state.createOffer);
  const toast = useToastStore((store) => store.show);
  const [form, setForm] = useState<OfferForm>(EMPTY_OFFER_FORM);
  const [errors, setErrors] = useState<OfferFormErrors>({});

  const submit = (): void => {
    const result = validateOfferForm(form);
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    createOffer(result.details, Date.now());
    toast(t('vendorMarketing.offerCreated'), 'success');
    setForm(EMPTY_OFFER_FORM);
    setErrors({});
    router.navigate('/marketing');
  };

  const field = (name: OfferField, label: string, value: string, key: 'value' | 'minCart') => {
    const error = errors[name];
    return (
      <View className="gap-1">
        <Text className="text-sm font-semibold text-gray-700">{label}</Text>
        <TextInput
          testID={`offer-${name}`}
          accessibilityLabel={label}
          value={value}
          keyboardType="decimal-pad"
          onChangeText={(text) => {
            setForm((current) => ({ ...current, [key]: sanitizeOfferInput(text) }));
          }}
          className={`min-h-12 rounded-xl border bg-white px-4 text-base text-gray-900 ${error === undefined ? 'border-gray-300' : 'border-red-500'}`}
        />
        {error === undefined ? null : (
          <Text className="text-sm text-red-700" testID={`offer-${name}-error`}>
            {t(`vendorMarketing.errors.${error}`)}
          </Text>
        )}
      </View>
    );
  };

  return (
    <KeyboardScreen testID="vendor-offer-form">
      <Text className="text-xl font-bold text-gray-900">{t('vendorMarketing.newOffer')}</Text>
      <Text className="text-sm text-gray-500">{t('vendorMarketing.offersNote')}</Text>

      <View className="gap-1">
        <Text className="text-sm font-semibold text-gray-700">{t('vendorMarketing.kind')}</Text>
        <SegmentedControl
          testID="offer-kind"
          segments={DISCOUNT_KINDS.map((kind) => ({
            value: kind,
            label: t(`vendorMarketing.kindLabel.${kind}`),
          }))}
          selected={form.kind}
          onSelect={(kind) => {
            setForm((current) => ({ ...current, kind }));
            setErrors({});
          }}
        />
      </View>

      {field(
        'value',
        t(form.kind === 'FLAT' ? 'vendorMarketing.flatAmount' : 'vendorMarketing.percentAmount'),
        form.value,
        'value',
      )}
      {field('minCart', t('vendorMarketing.minOrderField'), form.minCart, 'minCart')}

      <Button testID="offer-save" label={t('vendorMarketing.createOffer')} onPress={submit} />
    </KeyboardScreen>
  );
}
