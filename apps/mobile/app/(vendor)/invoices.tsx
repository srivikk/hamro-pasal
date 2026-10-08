import type { VendorInvoiceSummary } from '@hamro-pasal/shared-types';
import { useCallback, useState } from 'react';
import { ActivityIndicator, FlatList, Text, View, type ListRenderItem } from 'react-native';
import { useTranslation } from 'react-i18next';

import { ApiError } from '../../src/api/http';
import { INVOICE_ERROR_CODES } from '../../src/api/vendor-invoices';
import { Button } from '../../src/components/Button';
import {
  useDownloadInvoicePdf,
  useVendorInvoicesQuery,
} from '../../src/features/vendor/useVendorMarketing';
import { vendorOrderCode } from '../../src/features/vendor/VendorOrderCard';
import { useToastStore } from '../../src/store/useToastStore';

const keyOf = (invoice: VendorInvoiceSummary): string => invoice.id;

/**
 * SPEC core section 10 (Fiscal Invoicing): the invoices issued for the shop's delivered orders
 * (GET /api/vendor/invoices), newest first. Reached from the Ledger tab's header.
 *
 * The document itself is the server's PDF (GET …/:id/pdf): the app never lays an invoice out, so
 * it cannot alter one. **Each download is a numbered print**: the first is the original, each
 * later one a copy, and the server records it. The file is saved on the phone and handed to the
 * system share sheet (view, print, save, send).
 */
export default function VendorInvoicesScreen() {
  const { t } = useTranslation();
  const query = useVendorInvoicesQuery();
  const download = useDownloadInvoicePdf();
  const toast = useToastStore((store) => store.show);
  /** The invoice being downloaded; one at a time, so its button can say so. */
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const { hasNextPage, isFetchingNextPage, fetchNextPage, isFetchNextPageError } = query;
  const { mutate } = download;

  const save = useCallback(
    (invoice: VendorInvoiceSummary): void => {
      setDownloadingId(invoice.id);
      mutate(
        { id: invoice.id, invoiceSequence: invoice.invoice_sequence },
        {
          onSuccess: ({ copyNumber }) => {
            toast(
              copyNumber === 0
                ? t('invoice.savedOriginal', { number: invoice.invoice_sequence })
                : t('invoice.savedCopy', { number: invoice.invoice_sequence, copy: copyNumber }),
              'success',
            );
          },
          onError: (error) => {
            const code = error instanceof ApiError ? error.code : null;
            toast(
              t(
                code === INVOICE_ERROR_CODES.printUnavailable
                  ? 'invoice.printUnavailable'
                  : code === INVOICE_ERROR_CODES.notFound
                    ? 'invoice.notFound'
                    : 'invoice.downloadFailed',
              ),
              'error',
            );
          },
          onSettled: () => {
            setDownloadingId(null);
          },
        },
      );
    },
    [mutate, t, toast],
  );

  const renderItem = useCallback<ListRenderItem<VendorInvoiceSummary>>(
    ({ item }) => {
      const busy = downloadingId === item.id;
      return (
        <View
          className="gap-3 rounded-2xl bg-white p-4 shadow-sm"
          testID={`invoice-row-${item.id}`}
        >
          <View className="flex-row items-center justify-between gap-2">
            <Text className="flex-1 text-base font-bold text-gray-900">
              {item.invoice_sequence}
            </Text>
            <Text className="text-base font-semibold text-gray-900">
              {t('order.total', { amount: item.grand_total_npr })}
            </Text>
          </View>
          <Text className="text-sm text-gray-500">
            {t('invoice.rowTitle', {
              number: String(item.bill_number).padStart(6, '0'),
              fiscalYear: item.fiscal_year,
            })}
          </Text>
          <Text className="text-sm text-gray-500">
            {t('invoice.rowSubtitle', {
              code: vendorOrderCode(item.order_id),
              date: item.issued_date_bs,
              buyer: item.buyer_name,
            })}
          </Text>
          <Text className="text-sm text-gray-500" testID={`invoice-prints-${item.id}`}>
            {item.print_count === 0
              ? t('invoice.notPrinted')
              : t('invoice.printed', { count: item.print_count })}
          </Text>
          <Button
            testID={`download-invoice-${item.id}`}
            label={t(busy ? 'invoice.downloading' : 'invoice.download')}
            variant="secondary"
            // One download at a time: each is a numbered print.
            disabled={downloadingId !== null}
            onPress={() => {
              save(item);
            }}
          />
        </View>
      );
    },
    [downloadingId, save, t],
  );

  const pages = query.data?.pages;
  if (pages === undefined && !query.isError) {
    return (
      <View className="flex-1 items-center justify-center bg-gray-50" testID="vendor-invoices">
        <ActivityIndicator testID="invoices-loading" />
      </View>
    );
  }
  // Nothing loaded at all. A later page that fails keeps the list and offers a retry below it.
  if (pages === undefined) {
    return (
      <View className="flex-1 justify-center gap-3 bg-gray-50 p-4" testID="vendor-invoices">
        <Text className="text-center text-base text-gray-500" testID="invoices-error">
          {t('invoice.loadError')}
        </Text>
        <Button label={t('common.retry')} onPress={() => void query.refetch()} />
      </View>
    );
  }

  const invoices = pages.flatMap((page) => page.invoices);
  return (
    <View className="flex-1 bg-gray-50" testID="vendor-invoices">
      <FlatList
        testID="invoice-list"
        className="flex-1"
        contentContainerStyle={{ padding: 16, gap: 12 }}
        data={invoices}
        keyExtractor={keyOf}
        renderItem={renderItem}
        onEndReachedThreshold={0.5}
        onEndReached={() => {
          if (hasNextPage && !isFetchingNextPage && !isFetchNextPageError) {
            void fetchNextPage();
          }
        }}
        ListHeaderComponent={
          invoices.length > 0 ? (
            <Text className="text-sm text-gray-500" testID="invoice-print-note">
              {t('invoice.printNote')}
            </Text>
          ) : null
        }
        ListEmptyComponent={
          <Text className="text-center text-base text-gray-500" testID="invoice-list-empty">
            {t('invoice.empty')}
          </Text>
        }
        ListFooterComponent={
          isFetchingNextPage ? (
            <ActivityIndicator testID="invoices-loading-more" />
          ) : isFetchNextPageError ? (
            <Button
              testID="invoices-load-more"
              label={t('common.retry')}
              variant="secondary"
              onPress={() => void fetchNextPage()}
            />
          ) : null
        }
      />
    </View>
  );
}
