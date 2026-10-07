import { Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { formatNepalDateTime, type VendorInvoice } from './invoice-math';

function Meta({ label, value, testID }: { label: string; value: string; testID: string }) {
  return (
    <View className="flex-row justify-between gap-3">
      <Text className="text-xs text-black">{label}</Text>
      <Text className="flex-1 text-right text-xs font-semibold text-black" testID={testID}>
        {value}
      </Text>
    </View>
  );
}

function Total({
  label,
  value,
  testID,
  strong = false,
}: {
  label: string;
  value: string;
  testID: string;
  strong?: boolean;
}) {
  const weight = strong ? 'text-sm font-bold' : 'text-xs';
  return (
    <View className="flex-row justify-between gap-3">
      <Text className={`${weight} text-black`}>{label}</Text>
      <Text className={`${weight} text-black`} testID={testID}>
        {value}
      </Text>
    </View>
  );
}

/**
 * SPEC core section 10: the invoice as a fiscal document. Black on white, ruled, no colour:
 * header (seller, PAN, disclaimer), metadata (fiscal year, bill number, AD and BS dates, payment),
 * the itemised table with the taxable amount and VAT of every line, the totals and the amount in
 * words. It renders what it is given and calculates nothing.
 */
export function InvoiceDocument({ invoice }: { invoice: VendorInvoice }) {
  const { t } = useTranslation();
  // A tax document always shows two decimals, in ASCII digits.
  const money = (amount: number): string => amount.toFixed(2);
  const vatRegistered = invoice.seller_is_vat_registered;
  const platformDelivery =
    invoice.delivery_charged_by === 'PLATFORM' && invoice.delivery_charge_npr > 0;

  return (
    <View className="gap-3 border border-black bg-white p-4" testID={`invoice-${invoice.id}`}>
      <View className="items-center gap-0.5">
        <Text className="text-lg font-bold text-black" testID="invoice-seller-name">
          {invoice.seller_name}
        </Text>
        <Text className="text-center text-xs text-black">{invoice.seller_address}</Text>
        <Text className="text-xs text-black">{invoice.seller_phone}</Text>
        <Text className="text-xs font-semibold text-black" testID="invoice-seller-tax-id">
          {t(vatRegistered ? 'invoice.vatNumber' : 'invoice.panNumber', {
            number: invoice.seller_tax_id,
          })}
        </Text>
      </View>

      <Text
        className="border-y border-black py-1 text-center text-sm font-bold uppercase text-black"
        testID="invoice-title"
      >
        {t(vatRegistered ? 'invoice.taxInvoice' : 'invoice.panInvoice')}
      </Text>

      <View className="gap-1">
        <Meta
          testID="invoice-fiscal-year"
          label={t('invoice.fiscalYear')}
          value={invoice.fiscal_year}
        />
        <Meta
          testID="invoice-bill-number"
          label={t('invoice.billNumber')}
          value={String(invoice.bill_number).padStart(6, '0')}
        />
        <Meta testID="invoice-date-bs" label={t('invoice.dateBs')} value={invoice.issued_date_bs} />
        <Meta
          testID="invoice-date-ad"
          label={t('invoice.dateAd')}
          value={formatNepalDateTime(invoice.issued_at)}
        />
        <Meta
          testID="invoice-payment"
          label={t('invoice.payment')}
          value={t(`payment.${invoice.payment_method}`)}
        />
        <Meta testID="invoice-buyer" label={t('invoice.buyer')} value={invoice.buyer_name} />
        {invoice.buyer_tax_id === null ? null : (
          <Meta
            testID="invoice-buyer-tax-id"
            label={t('invoice.buyerPan')}
            value={invoice.buyer_tax_id}
          />
        )}
      </View>

      <View className="border-y border-black">
        <View className="flex-row gap-2 border-b border-black py-1">
          <Text className="flex-1 text-xs font-bold text-black">{t('invoice.particulars')}</Text>
          <Text className="w-16 text-right text-xs font-bold text-black">
            {t('invoice.taxable')}
          </Text>
          <Text className="w-14 text-right text-xs font-bold text-black">
            {t('invoice.vat', { rate: invoice.vat_rate_percent })}
          </Text>
          <Text className="w-16 text-right text-xs font-bold text-black">
            {t('invoice.amount')}
          </Text>
        </View>
        {invoice.lines.map((line) => (
          <View
            key={line.line_number}
            className="flex-row gap-2 border-b border-gray-300 py-1.5"
            testID={`invoice-line-${String(line.line_number)}`}
          >
            <View className="flex-1 gap-0.5">
              <Text className="text-xs font-semibold text-black">{line.product_name}</Text>
              <Text className="text-xs text-black">
                {t('invoice.quantityRate', {
                  quantity: line.quantity,
                  rate: money(line.unit_price_npr),
                })}
              </Text>
              {line.hs_code === null ? null : (
                <Text className="text-xs text-black">
                  {t('invoice.hsCode', { code: line.hs_code })}
                </Text>
              )}
              {line.line_discount_npr > 0 ? (
                <Text className="text-xs text-black">
                  {t('invoice.lineDiscount', { amount: money(line.line_discount_npr) })}
                </Text>
              ) : null}
            </View>
            <Text className="w-16 text-right text-xs text-black">
              {money(line.taxable_amount_npr)}
            </Text>
            <Text className="w-14 text-right text-xs text-black">{money(line.vat_amount_npr)}</Text>
            <Text className="w-16 text-right text-xs text-black">{money(line.line_total_npr)}</Text>
          </View>
        ))}
      </View>

      <View className="gap-1">
        <Total
          testID="invoice-subtotal"
          label={t('invoice.subtotal')}
          value={money(invoice.subtotal_npr)}
        />
        {invoice.discount_npr > 0 ? (
          <Total
            testID="invoice-discount"
            label={t('invoice.discount')}
            value={`- ${money(invoice.discount_npr)}`}
          />
        ) : null}
        {vatRegistered ? (
          <>
            <Total
              testID="invoice-taxable"
              label={t('invoice.taxableAmount')}
              value={money(invoice.taxable_amount_npr)}
            />
            <Total
              testID="invoice-vat"
              label={t('invoice.vatAmount', { rate: invoice.vat_rate_percent })}
              value={money(invoice.vat_amount_npr)}
            />
          </>
        ) : null}
        {invoice.exempt_amount_npr > 0 ? (
          <Total
            testID="invoice-exempt"
            label={t('invoice.exempt')}
            value={money(invoice.exempt_amount_npr)}
          />
        ) : null}
        <Total
          testID="invoice-delivery"
          label={t(platformDelivery ? 'invoice.deliveryPlatform' : 'invoice.delivery')}
          value={money(invoice.delivery_charge_npr)}
        />
        <View className="mt-1 border-t border-black pt-1">
          <Total
            strong
            testID="invoice-grand-total"
            label={t('invoice.grandTotal')}
            value={money(invoice.grand_total_npr)}
          />
        </View>
        <Text className="text-xs italic text-black" testID="invoice-in-words">
          {t('invoice.inWords', { words: invoice.amount_in_words })}
        </Text>
      </View>

      <Text
        className="border-t border-black pt-2 text-center text-xs text-black"
        testID="invoice-disclaimer"
      >
        {invoice.platform_disclaimer}
      </Text>
    </View>
  );
}
