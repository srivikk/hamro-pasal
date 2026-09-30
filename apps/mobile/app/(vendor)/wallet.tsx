import { Stack } from 'expo-router';
import { ActivityIndicator, FlatList, RefreshControl, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { Button } from '../../src/components/Button';
import {
  useVendorWalletBalanceQuery,
  useVendorWalletLedgerQuery,
} from '../../src/features/vendor/useVendorWallet';
import { WalletEntryRow } from '../../src/features/vendor/WalletEntryRow';
import { WalletSummary } from '../../src/features/vendor/WalletSummary';

/**
 * SPEC §5 (Phase 12): the vendor's wallet. The balance goes negative when the shop collects COD
 * cash that includes the platform's commission; below the platform limit the shop is SUSPENDED and
 * a red banner explains that it stays offline until the dues are paid. Below it, every posting
 * (order payouts, COD commission debits), newest first, loaded page by page as the list scrolls.
 */
export default function VendorWalletScreen() {
  const { t } = useTranslation();
  const balance = useVendorWalletBalanceQuery();
  const ledger = useVendorWalletLedgerQuery();
  const entries = ledger.data?.pages.flatMap((page) => page.entries) ?? [];
  const header = <Stack.Screen options={{ headerShown: true, title: t('vendorWallet.title') }} />;

  if (balance.data === undefined) {
    return (
      <View className="flex-1 items-center justify-center gap-4 bg-neutral-50 px-6">
        {header}
        {balance.isError ? (
          <>
            <Text className="text-center text-base text-neutral-700">
              {t('vendorWallet.loadError')}
            </Text>
            <Button label={t('common.retry')} onPress={() => void balance.refetch()} />
          </>
        ) : (
          <ActivityIndicator testID="wallet-loading" />
        )}
      </View>
    );
  }

  const ledgerPlaceholder = ledger.isPending ? (
    <ActivityIndicator testID="wallet-ledger-loading" />
  ) : ledger.isError ? (
    <View className="items-center gap-3">
      <Text className="text-center text-base text-neutral-700">{t('vendorWallet.loadError')}</Text>
      <Button label={t('common.retry')} onPress={() => void ledger.refetch()} />
    </View>
  ) : (
    <Text className="text-center text-base text-neutral-600" testID="wallet-ledger-empty">
      {t('vendorWallet.empty')}
    </Text>
  );

  const footer = ledger.isFetchingNextPage ? (
    <Text className="text-center text-sm text-neutral-600" testID="wallet-ledger-loading-more">
      {t('vendorWallet.loadingMore')}
    </Text>
  ) : ledger.isFetchNextPageError ? (
    <View className="items-center gap-2">
      <Text className="text-center text-sm text-neutral-700">
        {t('vendorWallet.loadMoreError')}
      </Text>
      <Button label={t('common.retry')} onPress={() => void ledger.fetchNextPage()} />
    </View>
  ) : null;

  return (
    <FlatList
      testID="wallet-ledger"
      className="flex-1 bg-neutral-50"
      contentContainerStyle={{ padding: 16, gap: 12 }}
      data={entries}
      keyExtractor={(entry) => entry.id}
      renderItem={({ item }) => <WalletEntryRow entry={item} />}
      ListHeaderComponent={
        <View className="gap-4">
          {header}
          <WalletSummary balance={balance.data} />
          <Text className="text-lg font-bold text-neutral-900">{t('vendorWallet.history')}</Text>
        </View>
      }
      ListEmptyComponent={ledgerPlaceholder}
      ListFooterComponent={footer}
      onEndReachedThreshold={0.5}
      onEndReached={() => {
        if (ledger.hasNextPage && !ledger.isFetchingNextPage && !ledger.isFetchNextPageError) {
          void ledger.fetchNextPage();
        }
      }}
      refreshControl={
        <RefreshControl
          refreshing={balance.isRefetching}
          onRefresh={() => {
            void balance.refetch();
            void ledger.refetch();
          }}
        />
      }
    />
  );
}
