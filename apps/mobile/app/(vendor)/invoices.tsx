import { useCallback, useMemo, useState } from 'react';
import { FlatList, Modal, ScrollView, Text, View, type ListRenderItem } from 'react-native';
import { useTranslation } from 'react-i18next';

import { Button } from '../../src/components/Button';
import { InvoiceDocument } from '../../src/features/vendor/InvoiceDocument';
import type { VendorInvoice } from '../../src/features/vendor/invoice-math';
import { mockInvoices } from '../../src/features/vendor/mock-invoices';
import { useShopSettings } from '../../src/features/vendor/useShopSettings';
import { vendorOrderCode } from '../../src/features/vendor/VendorOrderCard';

const keyOf = (invoice: VendorInvoice): string => invoice.id;

/**
 * SPEC core section 10 (Fiscal Invoicing): the invoices issued for the shop's delivered orders,
 * newest first, each opening as the fiscal document. Reached from the Ledger tab's header.
 *
 * TODO: `GET /api/vendor/invoices` for the list and `GET /api/vendor/invoices/:id` for the document
 * (which logs the view), then printing through `POST …/:id/print` (STATE_HANDOFF.md §8Z.11). Until
 * the server issues invoices these are sample documents (development builds only).
 */
export default function VendorInvoicesScreen() {
  const { t } = useTranslation();
  const settings = useShopSettings();
  const invoices = useMemo(() => mockInvoices(settings?.taxId ?? null), [settings?.taxId]);
  const [openId, setOpenId] = useState<string | null>(null);
  const open = invoices.find((invoice) => invoice.id === openId) ?? null;

  const renderItem = useCallback<ListRenderItem<VendorInvoice>>(
    ({ item }) => (
      <View className="gap-3 rounded-2xl bg-white p-4 shadow-sm" testID={`invoice-row-${item.id}`}>
        <View className="flex-row items-center justify-between">
          <Text className="text-base font-bold text-gray-900">
            {t('invoice.rowTitle', {
              number: String(item.bill_number).padStart(6, '0'),
              fiscalYear: item.fiscal_year,
            })}
          </Text>
          <Text className="text-base font-semibold text-gray-900">
            {t('order.total', { amount: item.grand_total_npr })}
          </Text>
        </View>
        <Text className="text-sm text-gray-500">
          {t('invoice.rowSubtitle', {
            code: vendorOrderCode(item.order_id),
            date: item.issued_date_bs,
            buyer: item.buyer_name,
          })}
        </Text>
        <Button
          testID={`view-invoice-${item.id}`}
          label={t('invoice.view')}
          variant="secondary"
          onPress={() => {
            setOpenId(item.id);
          }}
        />
      </View>
    ),
    [t],
  );

  return (
    <View className="flex-1 bg-gray-50" testID="vendor-invoices">
      <FlatList
        testID="invoice-list"
        className="flex-1"
        contentContainerStyle={{ padding: 16, gap: 12 }}
        data={invoices}
        keyExtractor={keyOf}
        renderItem={renderItem}
        ListHeaderComponent={
          invoices.length > 0 ? (
            <Text className="text-sm text-gray-500" testID="invoice-sample-note">
              {t('invoice.sampleNote')}
            </Text>
          ) : null
        }
        ListEmptyComponent={
          <Text className="text-center text-base text-gray-500" testID="invoice-list-empty">
            {t('invoice.empty')}
          </Text>
        }
      />

      <Modal
        visible={open !== null}
        animationType="slide"
        onRequestClose={() => {
          setOpenId(null);
        }}
      >
        <View className="flex-1 bg-white" testID="invoice-detail">
          <ScrollView contentContainerStyle={{ padding: 16, gap: 16 }}>
            {open === null ? null : <InvoiceDocument invoice={open} />}
            <Button
              testID="invoice-close"
              label={t('invoice.close')}
              variant="secondary"
              onPress={() => {
                setOpenId(null);
              }}
            />
          </ScrollView>
        </View>
      </Modal>
    </View>
  );
}
