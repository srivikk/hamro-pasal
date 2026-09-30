import type { VendorWalletLedgerEntry } from '@hamro-pasal/shared-types';
import { Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { useAuthStore } from '../../store/useAuthStore';
import { vendorOrderCode } from './VendorOrderCard';
import { formatBalance, formatPosting, formatPostedAt } from './wallet-format';

/** One wallet posting: what it was, which order, how much it moved and the balance after it. */
export function WalletEntryRow({ entry }: { entry: VendorWalletLedgerEntry }) {
  const { t } = useTranslation();
  const locale = useAuthStore((state) => state.locale);
  const debit = entry.amount_npr < 0;

  return (
    <View className="gap-1 rounded-2xl bg-white p-4" testID={`wallet-entry-${entry.id}`}>
      <View className="flex-row items-start justify-between gap-3">
        <View className="flex-1 gap-0.5">
          <Text className="text-base font-semibold text-neutral-900">
            {t(`vendorWallet.entry.${entry.entry_type}`)}
          </Text>
          {entry.order === null ? null : (
            <Text className="text-sm text-neutral-600">
              {t('vendorWallet.orderRef', { code: vendorOrderCode(entry.order.id) })}
            </Text>
          )}
        </View>
        <Text
          className={`text-base font-bold ${debit ? 'text-red-700' : 'text-green-700'}`}
          testID={`wallet-entry-amount-${entry.id}`}
        >
          {formatPosting(t, entry.amount_npr)}
        </Text>
      </View>
      {entry.order !== null && entry.order.commission_npr > 0 ? (
        <Text className="text-sm text-neutral-600">
          {t('vendorWallet.commission', {
            amount: entry.order.commission_npr,
            subtotal: entry.order.subtotal_npr,
          })}
        </Text>
      ) : null}
      <View className="flex-row justify-between">
        <Text className="text-xs text-neutral-500">{formatPostedAt(entry.created_at, locale)}</Text>
        <Text className="text-xs text-neutral-500">
          {t('vendorWallet.balanceAfter', { balance: formatBalance(t, entry.balance_after_npr) })}
        </Text>
      </View>
    </View>
  );
}
