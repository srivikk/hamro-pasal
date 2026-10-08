import Ionicons from '@expo/vector-icons/Ionicons';
import type { VendorOfferStatus, VendorOfferView } from '@hamro-pasal/shared-types';
import type { TFunction } from 'i18next';
import { router } from 'expo-router';
import { ActivityIndicator, Alert, Pressable, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { Button } from '../../components/Button';
import { useToastStore } from '../../store/useToastStore';
import { formatNepalDateTime } from './invoice-math';
import type { DiscountKind } from './marketing-rules';
import { useEndVendorOffer, useVendorOffersQuery } from './useVendorMarketing';

/** "Flat Rs. 100 OFF" or "20% OFF": the label a customer would see. */
export function discountLabel(t: TFunction, kind: DiscountKind, value: number): string {
  return t(kind === 'FLAT' ? 'vendorMarketing.flatLabel' : 'vendorMarketing.percentLabel', {
    value,
  });
}

const dateOf = (iso: string): string => formatNepalDateTime(iso).slice(0, 10);

const cardClass = 'gap-2 rounded-2xl bg-white p-4 shadow-sm';

/** The server's derived status: running, past its end date, or switched off by the shop. */
const STATUS_BADGE: Record<VendorOfferStatus, string> = {
  ACTIVE: 'bg-emerald-100 text-emerald-800',
  ENDED: 'bg-gray-200 text-gray-700',
  CANCELLED: 'bg-red-100 text-red-800',
};

/** When the offer stopped (or will stop) applying, in words; null while it runs open-ended. */
function offerEndLine(t: TFunction, offer: VendorOfferView): string | null {
  if (offer.status === 'CANCELLED' && offer.ended_at !== null) {
    return t('vendorMarketing.cancelledOn', { date: dateOf(offer.ended_at) });
  }
  if (offer.ends_at === null) return null;
  return t(offer.status === 'ENDED' ? 'vendorMarketing.endedOn' : 'vendorMarketing.runsUntil', {
    date: dateOf(offer.ends_at),
  });
}

/**
 * The vendor's own offers (GET /api/vendor/offers), newest first, each with the status the server
 * derives for it, and the button that opens the form for a new one. An offer is never edited:
 * ending it (POST …/:id/end) stops it for future orders; orders already priced keep it.
 */
export function MyOffers() {
  const { t } = useTranslation();
  const query = useVendorOffersQuery();
  const endOffer = useEndVendorOffer();
  const toast = useToastStore((store) => store.show);

  const end = (offer: VendorOfferView): void => {
    endOffer.mutate(offer.id, {
      onSuccess: () => {
        toast(t('vendorMarketing.ended'), 'success');
      },
      onError: () => {
        toast(t('vendorMarketing.actionFailed'), 'error');
      },
    });
  };

  if (query.isPending) {
    return <ActivityIndicator testID="offers-loading" />;
  }
  if (query.isError) {
    return (
      <View className="gap-3" testID="offers-error">
        <Text className="text-center text-base text-gray-500">
          {t('vendorMarketing.loadFailed')}
        </Text>
        <Button label={t('vendorMarketing.retry')} onPress={() => void query.refetch()} />
      </View>
    );
  }

  const offers = query.data.offers;
  return (
    <View className="gap-3" testID="marketing-offers">
      <Text className="text-sm text-gray-500">{t('vendorMarketing.offersNote')}</Text>
      {offers.length === 0 ? (
        <Text className="text-center text-base text-gray-500" testID="offers-empty">
          {t('vendorMarketing.offersEmpty')}
        </Text>
      ) : null}
      {offers.map((offer) => {
        const endLine = offerEndLine(t, offer);
        const running = offer.status === 'ACTIVE';
        return (
          <View
            key={offer.id}
            className={`${cardClass} ${running ? '' : 'opacity-70'}`}
            testID={`offer-${offer.id}`}
          >
            <View className="flex-row items-center justify-between gap-2">
              {/* The label is the server's: exactly what a customer is shown. */}
              <Text className="flex-1 text-lg font-bold text-gray-900">{offer.label}</Text>
              <Text
                testID={`offer-status-${offer.id}`}
                className={`rounded px-2 py-0.5 text-xs font-semibold ${STATUS_BADGE[offer.status]}`}
              >
                {t(`vendorMarketing.offerStatus.${offer.status}`)}
              </Text>
            </View>
            <Text className="text-sm text-gray-500">
              {offer.min_cart_npr > 0
                ? t('vendorMarketing.minOrder', { amount: offer.min_cart_npr })
                : t('vendorMarketing.noMinOrder')}
            </Text>
            <Text className="text-sm text-gray-500">
              {t('vendorMarketing.since', { date: dateOf(offer.starts_at) })}
            </Text>
            {endLine === null ? null : (
              <Text className="text-sm text-gray-500" testID={`offer-end-line-${offer.id}`}>
                {endLine}
              </Text>
            )}
            {running ? (
              <Button
                testID={`offer-end-${offer.id}`}
                label={t('vendorMarketing.endOffer')}
                variant="danger"
                size="sm"
                disabled={endOffer.isPending}
                onPress={() => {
                  Alert.alert(
                    t('vendorMarketing.endTitle', { label: offer.label }),
                    t('vendorMarketing.endBody'),
                    [
                      { text: t('vendorMarketing.cancel'), style: 'cancel' },
                      {
                        text: t('vendorMarketing.endOffer'),
                        style: 'destructive',
                        onPress: () => {
                          end(offer);
                        },
                      },
                    ],
                  );
                }}
              />
            ) : null}
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
