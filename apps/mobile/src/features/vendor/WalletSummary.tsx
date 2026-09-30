import type { VendorWalletBalanceResponseBody } from '@hamro-pasal/shared-types';
import { Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { formatBalance, suspensionReason } from './wallet-format';

/**
 * The top of the wallet screen: the suspension banner when the shop is offline, the balance
 * (red while negative) and the prepaid money still waiting in escrow.
 */
export function WalletSummary({ balance }: { balance: VendorWalletBalanceResponseBody }) {
  const { t } = useTranslation();
  const reason = suspensionReason(balance);
  const negative = balance.wallet_balance_npr < 0;

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
                  due: -balance.wallet_balance_npr,
                  limit: -balance.suspension_limit_npr,
                })
              : t('vendorWallet.suspendedOther')}
          </Text>
        </View>
      )}

      <View className="gap-1 rounded-2xl bg-white p-4" testID="wallet-balance-card">
        <Text className="text-sm text-neutral-600">{t('vendorWallet.balance')}</Text>
        <Text
          className={`text-3xl font-bold ${negative ? 'text-red-700' : 'text-neutral-900'}`}
          testID="wallet-balance"
        >
          {formatBalance(t, balance.wallet_balance_npr)}
        </Text>
        {balance.pending_escrow_order_count > 0 ? (
          <Text className="text-sm text-neutral-600" testID="wallet-pending-escrow">
            {t('vendorWallet.pendingEscrow', {
              amount: balance.pending_escrow_npr,
              count: balance.pending_escrow_order_count,
            })}
          </Text>
        ) : null}
      </View>
    </View>
  );
}
