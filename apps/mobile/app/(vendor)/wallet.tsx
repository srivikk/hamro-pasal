import { Stack } from 'expo-router';
import { ActivityIndicator, FlatList, Pressable, RefreshControl, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { Button } from '../../src/components/Button';
import {
  useVendorTopUp,
  useVendorWalletBalanceQuery,
  useVendorWalletLedgerQuery,
} from '../../src/features/vendor/useVendorWallet';
import {
  mockWalletBalance,
  SETTLEMENT_MODELS,
  useVendorFinanceStore,
  VENDOR_FINANCE_MOCKS_ENABLED,
} from '../../src/features/vendor/vendor-finance-mocks';
import { WalletEntryRow } from '../../src/features/vendor/WalletEntryRow';
import { WalletSummary } from '../../src/features/vendor/WalletSummary';

/**
 * SPEC §5 (Phase 12): the vendor's wallet. The balance goes negative when the shop collects COD
 * cash that includes the platform's commission; below the platform limit the shop is SUSPENDED and
 * a red banner explains that it stays offline until the dues are paid, with a button that pays
 * them (Phase 12.5). Below it, every posting (order payouts, COD commission debits, top-ups),
 * newest first, loaded page by page as the list scrolls.
 *
 * The balance card follows the shop's settlement model (SPEC Financial Governance). The server
 * only knows model B today, so a development build can preview A and C: those two always show
 * sample figures, and B does while the real balance cannot be loaded.
 */
export default function VendorWalletScreen() {
  const { t } = useTranslation();
  const balance = useVendorWalletBalanceQuery();
  const ledger = useVendorWalletLedgerQuery();
  const { payOutstanding, paying } = useVendorTopUp();
  const model = useVendorFinanceStore((state) => state.settlementModel);
  const setModel = useVendorFinanceStore((state) => state.setSettlementModel);
  // Sample figures stand in where no real one exists: models A and C, or an unreachable server.
  const sampled =
    VENDOR_FINANCE_MOCKS_ENABLED && (balance.data === undefined || model !== 'PLATFORM_ESCROW');
  const summary = sampled ? mockWalletBalance(model) : balance.data;
  const entries = ledger.data?.pages.flatMap((page) => page.entries) ?? [];
  const header = <Stack.Screen options={{ headerShown: true, title: t('vendorWallet.title') }} />;

  if (summary === undefined) {
    return (
      <View className="flex-1 items-center justify-center gap-4 bg-gray-50 px-6">
        {header}
        {balance.isError ? (
          <>
            <Text className="text-center text-base text-gray-700">
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
      <Text className="text-center text-base text-gray-700">{t('vendorWallet.loadError')}</Text>
      <Button label={t('common.retry')} onPress={() => void ledger.refetch()} />
    </View>
  ) : (
    <Text className="text-center text-base text-gray-500" testID="wallet-ledger-empty">
      {t('vendorWallet.empty')}
    </Text>
  );

  const footer = ledger.isFetchingNextPage ? (
    <Text className="text-center text-sm text-gray-500" testID="wallet-ledger-loading-more">
      {t('vendorWallet.loadingMore')}
    </Text>
  ) : ledger.isFetchNextPageError ? (
    <View className="items-center gap-2">
      <Text className="text-center text-sm text-gray-700">{t('vendorWallet.loadMoreError')}</Text>
      <Button label={t('common.retry')} onPress={() => void ledger.fetchNextPage()} />
    </View>
  ) : null;

  return (
    <FlatList
      testID="wallet-ledger"
      className="flex-1 bg-gray-50"
      contentContainerStyle={{ padding: 16, gap: 12 }}
      data={entries}
      keyExtractor={(entry) => entry.id}
      renderItem={({ item }) => <WalletEntryRow entry={item} />}
      ListHeaderComponent={
        <View className="gap-4">
          {header}
          {VENDOR_FINANCE_MOCKS_ENABLED ? (
            <View className="gap-2 rounded-2xl bg-white p-3" testID="ledger-model-preview">
              <Text className="text-sm text-gray-500">{t('vendorWallet.previewModel')}</Text>
              <View className="flex-row gap-2">
                {SETTLEMENT_MODELS.map((each) => (
                  <Pressable
                    key={each}
                    testID={`ledger-model-${each}`}
                    accessibilityRole="button"
                    accessibilityState={{ selected: each === model }}
                    onPress={() => {
                      setModel(each);
                    }}
                    className={`flex-1 items-center rounded-xl border-2 px-2 py-2 ${each === model ? 'border-brand bg-brand-light' : 'border-gray-200 bg-white'}`}
                  >
                    <Text className="text-sm font-semibold text-gray-900">
                      {t(`vendorWallet.modelShort.${each}`)}
                    </Text>
                  </Pressable>
                ))}
              </View>
            </View>
          ) : null}
          {sampled ? (
            <Text className="text-sm text-amber-900" testID="ledger-sample-note">
              {t('vendorWallet.sampleNote')}
            </Text>
          ) : null}
          <WalletSummary
            balance={summary}
            model={model}
            onPayDues={payOutstanding}
            paying={paying}
          />
          <Text className="text-lg font-bold text-gray-900">{t('vendorWallet.history')}</Text>
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
