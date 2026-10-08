import type { AdPurchaseView, VendorAdProductView } from '@hamro-pasal/shared-types';
import { randomUUID } from 'expo-crypto';
import type { TFunction } from 'i18next';
import { useState } from 'react';
import { ActivityIndicator, Modal, Pressable, Share, Text, TextInput, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { ApiError } from '../../api/http';
import { AD_ERROR_CODES } from '../../api/vendor-ads';
import { Button } from '../../components/Button';
import { useToastStore } from '../../store/useToastStore';
import { formatNepalDateTime } from './invoice-math';
import { sanitizeOfferInput } from './marketing-rules';
import { useMinuteClock } from './useVendorOrderSimulator';
import {
  useCancelVendorAdPurchase,
  usePurchaseVendorAd,
  useVendorAdProductsQuery,
  useVendorAdPurchasesQuery,
} from './useVendorMarketing';

const dateOf = (iso: string): string => formatNepalDateTime(iso).slice(0, 10);
const cardClass = 'gap-2 rounded-2xl bg-white p-4 shadow-sm';
const DAY_MS = 86_400_000;

/** When the ad starts, in days from now. The server takes any instant up to 90 days ahead. */
export const AD_START_OPTIONS = [0, 1, 3, 7] as const;
export type AdStartOption = (typeof AD_START_OPTIONS)[number];

export function adPriceLine(t: TFunction, product: VendorAdProductView): string {
  return t(
    product.billing_model === 'FLAT_RATE'
      ? 'vendorMarketing.flatRate'
      : 'vendorMarketing.perOrderFee',
    { price: product.price_npr, days: product.duration_days },
  );
}

/**
 * The shop can pay for this now. A courtesy before the form opens, on the server's own figures;
 * the server's guard under the vendor row lock is the rule. Model B buys a flat-rate ad against
 * what the platform holds for it and a per-order ad without holding anything; Models A and C must
 * have the price (or one fee, the smallest budget) in their ledger.
 */
export function canAffordAd(product: VendorAdProductView, availableForAdsNpr: number): boolean {
  if (product.collection === 'LEDGER_BALANCE') return product.recharge_required_npr === 0;
  return product.billing_model !== 'FLAT_RATE' || availableForAdsNpr >= product.price_npr;
}

/** A budget as typed: at least one fee, in whole paisa; null while it is not a valid amount. */
export function parseAdBudget(text: string, priceNpr: number): number | null {
  if (!/^\d+(\.\d{1,2})?$/.test(text.trim())) return null;
  const budget = Number(text);
  return budget >= priceNpr && budget <= 1_000_000 ? budget : null;
}

/** The first block of the purchase id, upper case: enough to recognise it on screen. */
export function shortAdId(purchaseId: string): string {
  return (purchaseId.split('-')[0] ?? purchaseId).toUpperCase();
}

/** A flat-rate ad whose period began runs to its end: the server refuses to cancel it. */
export function canCancelAd(purchase: AdPurchaseView, nowMs: number): boolean {
  if (purchase.status !== 'ACTIVE' && purchase.status !== 'PAUSED') return false;
  if (Date.parse(purchase.ends_at) <= nowMs) return false;
  return purchase.billing_model !== 'FLAT_RATE' || Date.parse(purchase.starts_at) > nowMs;
}

interface PurchaseDraft {
  readonly product: VendorAdProductView;
  /** One per opening of the form, kept across retries: a resent request never buys twice. */
  readonly idempotencyKey: string;
  readonly startInDays: AdStartOption;
  readonly budget: string;
  readonly budgetError: boolean;
}

/**
 * The Ad Marketplace (GET /api/vendor/ads/products, /purchases): the placements on sale, what the
 * shop can spend, and the ads it bought. An ad is charged only after the vendor's explicit
 * agreement in the purchase form, which restates the cost and how it is collected.
 */
export function VendorAdsSection() {
  const { t } = useTranslation();
  const market = useVendorAdProductsQuery();
  const purchases = useVendorAdPurchasesQuery();
  const purchase = usePurchaseVendorAd();
  const cancel = useCancelVendorAdPurchase();
  const toast = useToastStore((store) => store.show);
  const [draft, setDraft] = useState<PurchaseDraft | null>(null);
  // Re-read once a minute: an ad that starts while the screen is open loses its Cancel button.
  const now = useMinuteClock();

  if (market.isPending) return <ActivityIndicator testID="ads-loading" />;
  if (market.isError) {
    return (
      <View className="gap-3" testID="ads-error">
        <Text className="text-center text-base text-gray-500">
          {t('vendorMarketing.loadFailed')}
        </Text>
        <Button label={t('vendorMarketing.retry')} onPress={() => void market.refetch()} />
      </View>
    );
  }
  const { settlement_model: model, available_for_ads_npr: available, products } = market.data;

  const open = (product: VendorAdProductView): void => {
    // Refused before any agreement is asked, as the server would refuse it.
    if (!canAffordAd(product, available)) {
      toast(t('vendorMarketing.insufficientFunds'), 'error');
      return;
    }
    setDraft({
      product,
      idempotencyKey: randomUUID(),
      startInDays: 0,
      budget: '',
      budgetError: false,
    });
  };

  const confirm = (): void => {
    if (draft === null) return;
    const perOrder = draft.product.billing_model === 'PER_ORDER_PREMIUM';
    const budget = perOrder ? parseAdBudget(draft.budget, draft.product.price_npr) : null;
    if (perOrder && budget === null) {
      setDraft({ ...draft, budgetError: true });
      return;
    }
    purchase.mutate(
      {
        ad_product_id: draft.product.id,
        starts_at: new Date(Date.now() + draft.startInDays * DAY_MS).toISOString(),
        idempotency_key: draft.idempotencyKey,
        ...(budget === null ? {} : { budget_npr: budget }),
      },
      {
        onSuccess: () => {
          toast(t('vendorMarketing.bought', { name: draft.product.name }), 'success');
          setDraft(null);
        },
        onError: (error) => {
          const code = error instanceof ApiError ? error.code : null;
          if (
            code === AD_ERROR_CODES.exceedsPendingPayout ||
            code === AD_ERROR_CODES.rechargeRequired
          ) {
            toast(t('vendorMarketing.insufficientFunds'), 'error');
            setDraft(null);
          } else if (code === AD_ERROR_CODES.budgetInvalid) {
            setDraft((current) => (current === null ? null : { ...current, budgetError: true }));
          } else if (code === AD_ERROR_CODES.productNotFound) {
            toast(t('vendorMarketing.adGone'), 'error');
            setDraft(null);
          } else {
            // The form stays open with its key: pressing again resends the same purchase.
            toast(t('vendorMarketing.actionFailed'), 'error');
          }
        },
      },
    );
  };

  const withdraw = (bought: AdPurchaseView): void => {
    cancel.mutate(bought.id, {
      onSuccess: () => {
        toast(t('vendorMarketing.adCancelled'), 'success');
      },
      onError: (error) => {
        const refused = error instanceof ApiError && error.code === AD_ERROR_CODES.notCancellable;
        toast(
          t(refused ? 'vendorMarketing.notCancellable' : 'vendorMarketing.actionFailed'),
          'error',
        );
      },
    });
  };

  const bought = purchases.data?.purchases ?? [];
  return (
    <View className="gap-3" testID="marketing-ads">
      <View className={cardClass}>
        <Text className="text-sm text-gray-500">{t(`vendorMarketing.fundsLabel.${model}`)}</Text>
        <Text className="text-2xl font-bold text-gray-900" testID="ad-funds">
          {t('common.price', { amount: available })}
        </Text>
      </View>

      {products.length === 0 ? (
        <Text className="text-center text-base text-gray-500" testID="ads-empty">
          {t('vendorMarketing.adsEmpty')}
        </Text>
      ) : null}
      {products.map((product) => (
        <View key={product.id} className={cardClass} testID={`ad-${product.id}`}>
          <Text className="text-lg font-bold text-gray-900">{product.name}</Text>
          <Text className="text-sm text-gray-500">
            {t(`vendorMarketing.slotHint.${product.slot}`)}
          </Text>
          <Text className="text-base font-semibold text-gray-800">{adPriceLine(t, product)}</Text>
          {product.recharge_required_npr > 0 ? (
            <Text className="text-sm text-amber-900" testID={`ad-recharge-${product.id}`}>
              {t('vendorMarketing.rechargeNeeded', { amount: product.recharge_required_npr })}
            </Text>
          ) : null}
          <Button
            testID={`ad-buy-${product.id}`}
            label={t('vendorMarketing.buy')}
            onPress={() => {
              open(product);
            }}
          />
        </View>
      ))}

      <Text className="pt-2 text-base font-bold text-gray-900">{t('vendorMarketing.yourAds')}</Text>
      {purchases.isError ? (
        <Text className="text-sm text-gray-500" testID="ad-purchases-error">
          {t('vendorMarketing.loadFailed')}
        </Text>
      ) : null}
      {purchases.isSuccess && bought.length === 0 ? (
        <Text className="text-sm text-gray-500" testID="ad-purchases-empty">
          {t('vendorMarketing.noAds')}
        </Text>
      ) : null}
      {bought.map((each) => {
        const cancellable = canCancelAd(each, now);
        const running = each.status === 'ACTIVE' || each.status === 'PAUSED';
        return (
          <View key={each.id} className={cardClass} testID={`ad-purchase-${each.id}`}>
            <View className="flex-row items-center justify-between gap-2">
              <Text className="flex-1 text-base font-bold text-gray-900">{each.product_name}</Text>
              <Text
                testID={`ad-purchase-status-${each.id}`}
                className={`rounded px-2 py-0.5 text-xs font-semibold ${each.status === 'ACTIVE' ? 'bg-emerald-100 text-emerald-800' : 'bg-gray-200 text-gray-700'}`}
              >
                {t(`vendorMarketing.adStatus.${each.status}`)}
              </Text>
            </View>
            {/* The Super Admin needs the whole id to sponsor a carousel banner with this ad. */}
            <Pressable
              testID={`ad-id-${each.id}`}
              accessibilityRole="button"
              accessibilityLabel={t('vendorMarketing.adIdCopy')}
              onPress={() => {
                // The system sheet offers Copy; the app ships no clipboard module.
                void Share.share({ message: each.id }).catch(() => undefined);
              }}
              className="flex-row items-center justify-between gap-2 rounded-lg bg-gray-100 px-3 py-2"
            >
              <Text className="flex-1 text-sm text-gray-800" selectable>
                {t('vendorMarketing.adId', { id: shortAdId(each.id) })}
              </Text>
              <Text className="text-xs font-semibold text-brand">
                {t('vendorMarketing.adIdCopy')}
              </Text>
            </Pressable>
            <Text className="text-sm text-gray-700">
              {t('vendorMarketing.period', {
                from: dateOf(each.starts_at),
                to: dateOf(each.ends_at),
              })}
            </Text>
            <Text className="text-sm text-gray-700">
              {each.budget_npr === null
                ? t('vendorMarketing.adPaid', {
                    paid: each.amount_paid_npr,
                    price: each.price_npr,
                  })
                : t('vendorMarketing.adBudget', {
                    spent: each.amount_paid_npr,
                    budget: each.budget_npr,
                  })}
            </Text>
            {each.amount_due_npr > 0 ? (
              <Text className="text-sm text-amber-900" testID={`ad-purchase-due-${each.id}`}>
                {t('vendorMarketing.adDue', { amount: each.amount_due_npr })}
              </Text>
            ) : null}
            {cancellable ? (
              <Button
                testID={`ad-cancel-${each.id}`}
                label={t('vendorMarketing.cancelAd')}
                variant="secondary"
                size="sm"
                disabled={cancel.isPending}
                onPress={() => {
                  withdraw(each);
                }}
              />
            ) : running ? (
              <Text className="text-sm text-gray-500" testID={`ad-not-cancellable-${each.id}`}>
                {t('vendorMarketing.notCancellable')}
              </Text>
            ) : null}
          </View>
        );
      })}

      <Modal
        visible={draft !== null}
        transparent
        animationType="slide"
        onRequestClose={() => {
          setDraft(null);
        }}
      >
        {draft === null ? null : (
          <View className="flex-1 justify-end bg-black/40">
            <View className="gap-3 rounded-t-3xl bg-white p-5" testID="ad-purchase-form">
              <Text className="text-xl font-bold text-gray-900">
                {t('vendorMarketing.buyTitle', { name: draft.product.name })}
              </Text>
              <Text className="text-base text-gray-800">{adPriceLine(t, draft.product)}</Text>
              <Text className="text-sm text-gray-500">
                {t(`vendorMarketing.collection.${model}`)}
              </Text>

              <Text className="text-sm font-semibold text-gray-700">
                {t('vendorMarketing.startLabel')}
              </Text>
              <View className="flex-row flex-wrap gap-2">
                {AD_START_OPTIONS.map((days) => {
                  const selected = draft.startInDays === days;
                  return (
                    <Pressable
                      key={days}
                      testID={`ad-start-${String(days)}`}
                      accessibilityRole="radio"
                      accessibilityState={{ selected }}
                      onPress={() => {
                        setDraft({ ...draft, startInDays: days });
                      }}
                      className={`rounded-full border px-3 py-1.5 ${selected ? 'border-brand bg-brand-light' : 'border-gray-300 bg-white'}`}
                    >
                      <Text className="text-sm text-gray-900">
                        {days === 0
                          ? t('vendorMarketing.startNow')
                          : t('vendorMarketing.startInDays', { count: days })}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>

              {draft.product.billing_model === 'PER_ORDER_PREMIUM' ? (
                <>
                  <Text className="text-sm font-semibold text-gray-700">
                    {t('vendorMarketing.budgetLabel')}
                  </Text>
                  <TextInput
                    testID="ad-budget"
                    className="rounded-xl border border-gray-300 px-3 py-2 text-base text-gray-900"
                    keyboardType="decimal-pad"
                    value={draft.budget}
                    onChangeText={(text) => {
                      setDraft({ ...draft, budget: sanitizeOfferInput(text), budgetError: false });
                    }}
                  />
                  <Text
                    className={`text-sm ${draft.budgetError ? 'text-red-700' : 'text-gray-500'}`}
                    testID={draft.budgetError ? 'ad-budget-error' : 'ad-budget-hint'}
                  >
                    {t('vendorMarketing.budgetHint', { price: draft.product.price_npr })}
                  </Text>
                </>
              ) : null}

              <Button
                testID="ad-purchase-confirm"
                label={t(
                  purchase.isPending ? 'vendorMarketing.buying' : 'vendorMarketing.buyConfirm',
                )}
                disabled={purchase.isPending}
                onPress={confirm}
              />
              <Button
                testID="ad-purchase-close"
                label={t('vendorMarketing.cancel')}
                variant="secondary"
                disabled={purchase.isPending}
                onPress={() => {
                  setDraft(null);
                }}
              />
            </View>
          </View>
        )}
      </Modal>
    </View>
  );
}
