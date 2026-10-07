import type { VendorWalletBalanceResponseBody } from '@hamro-pasal/shared-types';
import { Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { Button } from '../../components/Button';
import {
  creditUsedFraction,
  PREPAID_RESERVE_NPR,
  type SettlementModel,
} from './vendor-finance-mocks';
import { formatBalance, outstandingDues, suspensionReason } from './wallet-format';

/**
 * The top of the wallet screen: the suspension banner when the shop is offline (with the "Pay
 * outstanding balance" button for a debt suspension), then the shop's money as its settlement
 * model sees it:
 *  - A, COD credit: the credit balance and how much of the credit limit is used;
 *  - B, platform escrow: what is available for payout and what is still pending in escrow;
 *  - C, prepaid: the active reserve balance against the Fixed Reserve.
 */
export interface WalletSummaryProps {
  balance: VendorWalletBalanceResponseBody;
  /** Pays exactly the outstanding dues (Phase 12.5). */
  onPayDues: (amountNpr: number) => void;
  paying: boolean;
  /** Defaults to B, the model every shop runs on today. */
  model?: SettlementModel;
}

const CREDIT_BAR_SEGMENTS = 10;

/** The credit limit as a bar of ten blocks: filled blocks are credit already used. */
function CreditBar({ fraction }: { fraction: number }) {
  const filled = Math.round(fraction * CREDIT_BAR_SEGMENTS);
  const danger = fraction >= 0.8;
  return (
    <View
      testID="wallet-credit-bar"
      accessibilityRole="progressbar"
      accessibilityValue={{ min: 0, max: 100, now: Math.round(fraction * 100) }}
      className="flex-row gap-1"
    >
      {Array.from({ length: CREDIT_BAR_SEGMENTS }, (_, index) => (
        <View
          key={index}
          className={`h-3 flex-1 rounded-full ${index >= filled ? 'bg-gray-200' : danger ? 'bg-red-600' : 'bg-amber-500'}`}
        />
      ))}
    </View>
  );
}

function Figure({ label, value, testID }: { label: string; value: string; testID: string }) {
  return (
    <View className="flex-1 gap-0.5">
      <Text className="text-sm text-gray-500">{label}</Text>
      <Text className="text-xl font-bold text-gray-900" testID={testID}>
        {value}
      </Text>
    </View>
  );
}

export function WalletSummary({
  balance,
  onPayDues,
  paying,
  model = 'PLATFORM_ESCROW',
}: WalletSummaryProps) {
  const { t } = useTranslation();
  const reason = suspensionReason(balance);
  const dues = outstandingDues(balance);
  const negative = balance.wallet_balance_npr < 0;
  const limit = -balance.suspension_limit_npr;
  const used = Math.min(limit, Math.max(0, -balance.wallet_balance_npr));

  return (
    <View className="gap-4">
      {reason === null ? null : (
        <View
          className="gap-1 rounded-2xl border-2 border-red-900 bg-red-700 p-4"
          accessibilityRole="alert"
          testID="wallet-suspended-banner"
        >
          <Text className="text-lg font-bold text-white">{t('vendorWallet.suspendedTitle')}</Text>
          <Text className="text-base text-white">
            {reason === 'DEBT'
              ? t('vendorWallet.suspendedBody', {
                  due: dues,
                  limit: -balance.suspension_limit_npr,
                })
              : t('vendorWallet.suspendedOther')}
          </Text>
          {reason === 'DEBT' && dues > 0 ? (
            <View className="mt-2">
              <Button
                label={
                  paying ? t('vendorWallet.paying') : t('vendorWallet.payDues', { amount: dues })
                }
                variant="secondary"
                disabled={paying}
                testID="wallet-pay-dues"
                onPress={() => {
                  onPayDues(dues);
                }}
              />
            </View>
          ) : null}
        </View>
      )}

      <View className="gap-3 rounded-2xl bg-white p-4" testID="wallet-balance-card">
        <Text className="text-xs font-semibold uppercase text-gray-500" testID="wallet-model">
          {t(`vendorWallet.model.${model}`)}
        </Text>
        <View className="gap-1">
          <Text className="text-sm text-gray-500">{t(`vendorWallet.balanceLabel.${model}`)}</Text>
          <Text
            className={`text-3xl font-bold ${negative ? 'text-red-700' : 'text-gray-900'}`}
            testID="wallet-balance"
          >
            {formatBalance(t, balance.wallet_balance_npr)}
          </Text>
        </View>

        {model === 'COD_CREDIT' ? (
          <View className="gap-2">
            <CreditBar
              fraction={creditUsedFraction(
                balance.wallet_balance_npr,
                balance.suspension_limit_npr,
              )}
            />
            <Text className="text-sm text-gray-500" testID="wallet-credit-used">
              {t('vendorWallet.creditUsed', { used, limit })}
            </Text>
            <Text className="text-sm text-gray-500">{t('vendorWallet.creditHint', { limit })}</Text>
          </View>
        ) : null}

        {model === 'PLATFORM_ESCROW' ? (
          <View className="gap-2">
            <View className="flex-row gap-4">
              <Figure
                testID="wallet-escrow-amount"
                label={t('vendorWallet.pendingEscrowLabel')}
                value={formatBalance(t, balance.pending_escrow_npr)}
              />
              <Figure
                testID="wallet-available-amount"
                label={t('vendorWallet.availableLabel')}
                value={formatBalance(t, Math.max(0, balance.wallet_balance_npr))}
              />
            </View>
            {balance.pending_escrow_order_count > 0 ? (
              <Text className="text-sm text-gray-500" testID="wallet-pending-escrow">
                {t('vendorWallet.pendingEscrow', {
                  amount: balance.pending_escrow_npr,
                  count: balance.pending_escrow_order_count,
                })}
              </Text>
            ) : null}
          </View>
        ) : null}

        {model === 'DIRECT_PREPAID' ? (
          <View className="gap-1">
            <Text className="text-sm text-gray-500" testID="wallet-reserve">
              {t('vendorWallet.reserve', {
                reserve: PREPAID_RESERVE_NPR,
                above: Math.max(0, balance.wallet_balance_npr - PREPAID_RESERVE_NPR),
              })}
            </Text>
            <Text className="text-sm text-gray-500">{t('vendorWallet.reserveHint')}</Text>
          </View>
        ) : null}
      </View>
    </View>
  );
}
