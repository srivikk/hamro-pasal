import Ionicons from '@expo/vector-icons/Ionicons';
import type { TFunction } from 'i18next';
import { router } from 'expo-router';
import { Alert, Pressable, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { Button } from '../../components/Button';
import { useToastStore } from '../../store/useToastStore';
import { useVendorMarketingStore } from '../../store/useVendorMarketingStore';
import { formatNepalDateTime } from './invoice-math';
import type { DiscountKind } from './marketing-rules';

/** "Flat Rs. 100 OFF" or "20% OFF": the label a customer would see. */
export function discountLabel(t: TFunction, kind: DiscountKind, value: number): string {
  return t(kind === 'FLAT' ? 'vendorMarketing.flatLabel' : 'vendorMarketing.percentLabel', {
    value,
  });
}

const dateOf = (iso: string): string => formatNepalDateTime(iso).slice(0, 10);

const cardClass = 'gap-2 rounded-2xl bg-white p-4 shadow-sm';

/** The vendor's own running offers, and the button that opens the form for a new one. */
export function MyOffers() {
  const { t } = useTranslation();
  const offers = useVendorMarketingStore((state) => state.offers);
  const endOffer = useVendorMarketingStore((state) => state.endOffer);
  const toast = useToastStore((store) => store.show);

  return (
    <View className="gap-3" testID="marketing-offers">
      <Text className="text-sm text-gray-500">{t('vendorMarketing.offersNote')}</Text>
      {offers.length === 0 ? (
        <Text className="text-center text-base text-gray-500" testID="offers-empty">
          {t('vendorMarketing.offersEmpty')}
        </Text>
      ) : null}
      {offers.map((offer) => {
        const label = discountLabel(t, offer.kind, offer.value);
        return (
          <View key={offer.id} className={cardClass} testID={`offer-${offer.id}`}>
            <View className="flex-row items-center justify-between">
              <Text className="text-lg font-bold text-gray-900">{label}</Text>
              <Text className="rounded bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-800">
                {t('vendorMarketing.active')}
              </Text>
            </View>
            <Text className="text-sm text-gray-500">
              {offer.minCartNpr > 0
                ? t('vendorMarketing.minOrder', { amount: offer.minCartNpr })
                : t('vendorMarketing.noMinOrder')}
            </Text>
            <Text className="text-sm text-gray-500">
              {t('vendorMarketing.since', { date: dateOf(offer.startsAt) })}
            </Text>
            <Button
              testID={`offer-end-${offer.id}`}
              label={t('vendorMarketing.endOffer')}
              variant="danger"
              size="sm"
              onPress={() => {
                Alert.alert(
                  t('vendorMarketing.endTitle', { label }),
                  t('vendorMarketing.endBody'),
                  [
                    { text: t('vendorMarketing.cancel'), style: 'cancel' },
                    {
                      text: t('vendorMarketing.endOffer'),
                      style: 'destructive',
                      onPress: () => {
                        endOffer(offer.id);
                        toast(t('vendorMarketing.ended'), 'success');
                      },
                    },
                  ],
                );
              }}
            />
          </View>
        );
      })}
      <Pressable
        testID="offer-add"
        accessibilityRole="button"
        accessibilityLabel={t('vendorMarketing.newOffer')}
        className="h-14 flex-row items-center justify-center gap-2 self-end rounded-full bg-brand px-5 shadow-sm active:bg-brand-dark"
        onPress={() => {
          router.push('/offer');
        }}
      >
        <Ionicons name="add" size={24} color="#FFFFFF" />
        <Text className="text-base font-semibold text-white">{t('vendorMarketing.newOffer')}</Text>
      </Pressable>
    </View>
  );
}
