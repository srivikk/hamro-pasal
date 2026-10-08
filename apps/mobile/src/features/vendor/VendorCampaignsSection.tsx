import type { VendorCampaignView } from '@hamro-pasal/shared-types';
import type { TFunction } from 'i18next';
import { useState } from 'react';
import { ActivityIndicator, Alert, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { ApiError } from '../../api/http';
import { CAMPAIGN_ERROR_CODES } from '../../api/vendor-campaigns';
import { Button } from '../../components/Button';
import { useToastStore } from '../../store/useToastStore';
import { formatNepalDateTime } from './invoice-math';
import { discountLabel } from './MarketingSections';
import { useCampaignOptIn, useCampaignOptOut, useVendorCampaignsQuery } from './useVendorMarketing';

const dateOf = (iso: string): string => formatNepalDateTime(iso).slice(0, 10);
const cardClass = 'gap-2 rounded-2xl bg-white p-4 shadow-sm';

/** The terms a vendor agrees to, one line each, exactly as the server lists them now. */
export function campaignTerms(t: TFunction, campaign: VendorCampaignView): string[] {
  return [
    campaign.max_discount_npr === null
      ? discountLabel(t, campaign.kind, campaign.value)
      : t('vendorMarketing.cappedDiscount', {
          label: discountLabel(t, campaign.kind, campaign.value),
          cap: campaign.max_discount_npr,
        }),
    t('vendorMarketing.minOrder', { amount: campaign.min_cart_npr }),
    t('vendorMarketing.yourShare', {
      share: campaign.vendor_share_percent,
      rest: 100 - campaign.vendor_share_percent,
    }),
    t('vendorMarketing.period', { from: dateOf(campaign.starts_at), to: dateOf(campaign.ends_at) }),
  ];
}

/**
 * The platform campaigns this shop is invited to (GET /api/vendor/campaigns). Nothing is on by
 * default: a campaign applies only after the vendor presses Opt In and confirms the terms, which
 * are restated in the prompt and sent as the `terms_version` the vendor was shown.
 *
 * If the terms changed meanwhile the server refuses (409 CAMPAIGN_TERMS_CHANGED): the list is
 * refetched, the card shows the new terms with a notice, and the vendor opts in again or not.
 */
export function VendorCampaignsSection() {
  const { t } = useTranslation();
  const query = useVendorCampaignsQuery();
  const optIn = useCampaignOptIn();
  const optOut = useCampaignOptOut();
  const toast = useToastStore((store) => store.show);
  /** Campaigns whose terms the server said had changed since they were shown. */
  const [changed, setChanged] = useState<readonly string[]>([]);
  const busy = optIn.isPending || optOut.isPending;

  const join = (campaign: VendorCampaignView): void => {
    optIn.mutate(
      { campaignId: campaign.id, termsVersion: campaign.terms_version },
      {
        onSuccess: () => {
          setChanged((ids) => ids.filter((id) => id !== campaign.id));
          toast(t('vendorMarketing.optedIn', { name: campaign.name }), 'success');
        },
        onError: (error) => {
          const code = error instanceof ApiError ? error.code : null;
          if (code === CAMPAIGN_ERROR_CODES.termsChanged) {
            setChanged((ids) => [...ids.filter((id) => id !== campaign.id), campaign.id]);
            toast(t('vendorMarketing.termsChangedToast'), 'error');
          } else if (
            code === CAMPAIGN_ERROR_CODES.ended ||
            code === CAMPAIGN_ERROR_CODES.notFound
          ) {
            toast(t('vendorMarketing.campaignGone'), 'error');
          } else {
            toast(t('vendorMarketing.actionFailed'), 'error');
          }
        },
      },
    );
  };

  const leave = (campaign: VendorCampaignView): void => {
    optOut.mutate(campaign.id, {
      onSuccess: () => {
        toast(t('vendorMarketing.optedOut'), 'success');
      },
      onError: (error) => {
        // Already out (the terms changed and voided it, or another device left): the list says so.
        const alreadyOut =
          error instanceof ApiError && error.code === CAMPAIGN_ERROR_CODES.notOptedIn;
        toast(t(alreadyOut ? 'vendorMarketing.optedOut' : 'vendorMarketing.actionFailed'), 'error');
      },
    });
  };

  if (query.isPending) {
    return <ActivityIndicator testID="campaigns-loading" />;
  }
  if (query.isError) {
    return (
      <View className="gap-3" testID="campaigns-error">
        <Text className="text-center text-base text-gray-500">
          {t('vendorMarketing.loadFailed')}
        </Text>
        <Button label={t('vendorMarketing.retry')} onPress={() => void query.refetch()} />
      </View>
    );
  }

  const campaigns = query.data.campaigns;
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
        const joined = campaign.opt_in_status === 'ACTIVE';
        // The vendor agreed to earlier terms, or was just refused for showing stale ones.
        const termsMoved = campaign.opt_in_status === 'VOIDED' || changed.includes(campaign.id);
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
            {!joined && termsMoved ? (
              <Text
                className="rounded-lg bg-amber-50 p-2 text-sm font-semibold text-amber-900"
                testID={`campaign-terms-changed-${campaign.id}`}
              >
                {t('vendorMarketing.termsChanged')}
              </Text>
            ) : null}
            {terms.map((line) => (
              <Text key={line} className="text-sm text-gray-700">
                {line}
              </Text>
            ))}
            {joined ? (
              <>
                {campaign.opted_in_at === null ? null : (
                  <Text className="text-sm text-gray-500" testID={`campaign-joined-${campaign.id}`}>
                    {t('vendorMarketing.joinedOn', { date: dateOf(campaign.opted_in_at) })}
                  </Text>
                )}
                <Button
                  testID={`campaign-opt-out-${campaign.id}`}
                  label={t('vendorMarketing.optOut')}
                  variant="secondary"
                  size="sm"
                  disabled={busy}
                  onPress={() => {
                    leave(campaign);
                  }}
                />
              </>
            ) : (
              <Button
                testID={`campaign-opt-in-${campaign.id}`}
                label={t('vendorMarketing.optIn')}
                disabled={busy}
                onPress={() => {
                  Alert.alert(
                    t('vendorMarketing.optInTitle', { name: campaign.name }),
                    t('vendorMarketing.optInBody', { terms: terms.join('\n') }),
                    [
                      { text: t('vendorMarketing.cancel'), style: 'cancel' },
                      {
                        text: t('vendorMarketing.optInConfirm'),
                        onPress: () => {
                          join(campaign);
                        },
                      },
                    ],
                  );
                }}
              />
            )}
          </View>
        );
      })}
    </View>
  );
}
