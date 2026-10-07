import Ionicons from '@expo/vector-icons/Ionicons';
import type { TFunction } from 'i18next';
import { router } from 'expo-router';
import { Alert, Pressable, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { Button } from '../../components/Button';
import { useToastStore } from '../../store/useToastStore';
import { useVendorMarketingStore } from '../../store/useVendorMarketingStore';
import { formatNepalDateTime } from './invoice-math';
import {
  adFundsAvailable,
  canBuyAd,
  type AdFunds,
  type AdProduct,
  type CampaignInvite,
  type DiscountKind,
} from './marketing-rules';
import { mockWalletBalance, useVendorFinanceStore } from './vendor-finance-mocks';

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

function campaignTerms(t: TFunction, campaign: CampaignInvite): string[] {
  return [
    campaign.maxDiscountNpr === null
      ? discountLabel(t, campaign.kind, campaign.value)
      : t('vendorMarketing.cappedDiscount', {
          label: discountLabel(t, campaign.kind, campaign.value),
          cap: campaign.maxDiscountNpr,
        }),
    t('vendorMarketing.minOrder', { amount: campaign.minCartNpr }),
    t('vendorMarketing.yourShare', {
      share: campaign.vendorSharePercent,
      rest: 100 - campaign.vendorSharePercent,
    }),
    t('vendorMarketing.period', { from: dateOf(campaign.startsAt), to: dateOf(campaign.endsAt) }),
  ];
}

/**
 * The platform campaigns this shop is invited to. Nothing is on by default: a campaign applies
 * only after the vendor presses Opt In and confirms the terms, which are restated in the prompt.
 */
export function CampaignInvites() {
  const { t } = useTranslation();
  const campaigns = useVendorMarketingStore((state) => state.campaigns);
  const optIn = useVendorMarketingStore((state) => state.optIn);
  const optOut = useVendorMarketingStore((state) => state.optOut);
  const toast = useToastStore((store) => store.show);

  return (
    <View className="gap-3" testID="marketing-campaigns">
      <Text className="text-sm text-gray-500">{t('vendorMarketing.campaignsNote')}</Text>
      {campaigns.length === 0 ? (
        <Text className="text-center text-base text-gray-500" testID="campaigns-empty">
          {t('vendorMarketing.campaignsEmpty')}
        </Text>
      ) : null}
      {campaigns.map((campaign) => {
        const terms = campaignTerms(t, campaign);
        const joined = campaign.optedInAt !== null;
        return (
          <View key={campaign.id} className={cardClass} testID={`campaign-${campaign.id}`}>
            <View className="flex-row items-center justify-between gap-2">
              <Text className="flex-1 text-lg font-bold text-gray-900">{campaign.name}</Text>
              <Text
                testID={`campaign-status-${campaign.id}`}
                className={`rounded px-2 py-0.5 text-xs font-semibold ${joined ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-900'}`}
              >
                {t(joined ? 'vendorMarketing.joined' : 'vendorMarketing.invited')}
              </Text>
            </View>
            {terms.map((line) => (
              <Text key={line} className="text-sm text-gray-700">
                {line}
              </Text>
            ))}
            {campaign.optedInAt === null ? (
              <Button
                testID={`campaign-opt-in-${campaign.id}`}
                label={t('vendorMarketing.optIn')}
                onPress={() => {
                  Alert.alert(
                    t('vendorMarketing.optInTitle', { name: campaign.name }),
                    t('vendorMarketing.optInBody', { terms: terms.join('\n') }),
                    [
                      { text: t('vendorMarketing.cancel'), style: 'cancel' },
                      {
                        text: t('vendorMarketing.optInConfirm'),
                        onPress: () => {
                          optIn(campaign.id, Date.now());
                          toast(t('vendorMarketing.optedIn', { name: campaign.name }), 'success');
                        },
                      },
                    ],
                  );
                }}
              />
            ) : (
              <>
                <Text className="text-sm text-gray-500" testID={`campaign-joined-${campaign.id}`}>
                  {t('vendorMarketing.joinedOn', { date: dateOf(campaign.optedInAt) })}
                </Text>
                <Button
                  testID={`campaign-opt-out-${campaign.id}`}
                  label={t('vendorMarketing.optOut')}
                  variant="secondary"
                  size="sm"
                  onPress={() => {
                    optOut(campaign.id);
                    toast(t('vendorMarketing.optedOut'), 'success');
                  }}
                />
              </>
            )}
          </View>
        );
      })}
    </View>
  );
}

/**
 * The sample shop's money as the Ad Marketplace sees it: the Ledger's sample figures for the
 * settlement model in use, less what flat-rate ads bought this sitting have already taken.
 */
function useAdFunds(): AdFunds {
  const model = useVendorFinanceStore((state) => state.settlementModel);
  const purchases = useVendorMarketingStore((state) => state.adPurchases);
  const products = useVendorMarketingStore((state) => state.adProducts);
  const balance = mockWalletBalance(model);
  const committedNpr = purchases.reduce((sum, purchase) => {
    const product = products.find((each) => each.id === purchase.adProductId);
    if (product === undefined) return sum;
    return sum + (product.billingModel === 'FLAT_RATE' ? product.priceNpr : 0);
  }, 0);
  return {
    model,
    balanceNpr: balance.wallet_balance_npr,
    pendingEscrowNpr: balance.pending_escrow_npr,
    committedNpr,
  };
}

function adPriceLine(t: TFunction, product: AdProduct): string {
  return product.billingModel === 'FLAT_RATE'
    ? t('vendorMarketing.flatRate', { price: product.priceNpr, days: product.durationDays })
    : t('vendorMarketing.perOrder', {
        price: product.priceNpr,
        budget: product.budgetNpr ?? 0,
        days: product.durationDays,
      });
}

/**
 * The sponsored placements on sale. Buying one checks first that the shop can pay for it under its
 * settlement model (a Model B shop: balance + pending escrow must cover a flat-rate price), then
 * asks for an explicit agreement that restates the cost: an ad is never charged without it.
 */
export function AdMarketplace() {
  const { t } = useTranslation();
  const products = useVendorMarketingStore((state) => state.adProducts);
  const purchases = useVendorMarketingStore((state) => state.adPurchases);
  const purchaseAd = useVendorMarketingStore((state) => state.purchaseAd);
  const toast = useToastStore((store) => store.show);
  const funds = useAdFunds();

  const buy = (product: AdProduct): void => {
    if (!canBuyAd(funds, product)) {
      toast(t('vendorMarketing.insufficientFunds'), 'error');
      return;
    }
    const name = t(`vendorMarketing.slot.${product.slot}`);
    Alert.alert(
      t('vendorMarketing.buyTitle', { name }),
      t('vendorMarketing.buyBody', {
        price: adPriceLine(t, product),
        collection: t(`vendorMarketing.collection.${funds.model}`),
      }),
      [
        { text: t('vendorMarketing.cancel'), style: 'cancel' },
        {
          text: t('vendorMarketing.buyConfirm'),
          onPress: () => {
            purchaseAd(product.id, Date.now());
            toast(t('vendorMarketing.bought', { name }), 'success');
          },
        },
      ],
    );
  };

  return (
    <View className="gap-3" testID="marketing-ads">
      <View className={cardClass}>
        <Text className="text-sm text-gray-500">
          {t(`vendorMarketing.fundsLabel.${funds.model}`)}
        </Text>
        <Text className="text-2xl font-bold text-gray-900" testID="ad-funds">
          {t('common.price', {
            amount:
              funds.model === 'PLATFORM_ESCROW'
                ? adFundsAvailable(funds)
                : funds.balanceNpr - funds.committedNpr,
          })}
        </Text>
        <Text className="text-sm text-gray-500">{t('vendorMarketing.fundsSample')}</Text>
      </View>

      {products.map((product) => {
        const bought = purchases.filter((purchase) => purchase.adProductId === product.id).length;
        return (
          <View key={product.id} className={cardClass} testID={`ad-${product.id}`}>
            <View className="flex-row items-center justify-between gap-2">
              <Text className="flex-1 text-lg font-bold text-gray-900">
                {t(`vendorMarketing.slot.${product.slot}`)}
              </Text>
              {bought > 0 ? (
                <Text
                  testID={`ad-active-${product.id}`}
                  className="rounded bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-800"
                >
                  {t('vendorMarketing.active')}
                </Text>
              ) : null}
            </View>
            <Text className="text-sm text-gray-500">
              {t(`vendorMarketing.slotHint.${product.slot}`)}
            </Text>
            <Text className="text-base font-semibold text-gray-800">{adPriceLine(t, product)}</Text>
            <Button
              testID={`ad-buy-${product.id}`}
              label={t('vendorMarketing.buy')}
              onPress={() => {
                buy(product);
              }}
            />
          </View>
        );
      })}
    </View>
  );
}
