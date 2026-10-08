import type { PaymentMethod } from '@hamro-pasal/shared-types';
import { Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import type { OrderReceipt } from '../../store/useOrderReceiptStore';

function Row({
  label,
  value,
  tone = 'plain',
  testID,
}: {
  label: string;
  value: string;
  tone?: 'plain' | 'discount' | 'total';
  testID?: string;
}) {
  const style =
    tone === 'total'
      ? 'text-base font-extrabold text-gray-900'
      : tone === 'discount'
        ? 'text-sm font-semibold text-green-700'
        : 'text-sm text-gray-700';
  return (
    <View className="flex-row justify-between" testID={testID}>
      <Text className={style}>{label}</Text>
      <Text className={style}>{value}</Text>
    </View>
  );
}

const withLabel = (title: string, label: string | null): string =>
  label === null ? title : `${title} · ${label}`;

/**
 * "Bill Details" of an order (SPEC "Checkout and Cart Math Protocol"): item total, the shop's own
 * offer, the platform promotion, delivery fee, platform fee, the total and how it was paid.
 * total = item total - shop offer - promotion + delivery fee.
 *
 * Every amount is the server's. The lines come from the receipt this phone kept at checkout (the
 * order as the server priced it); an order without one (placed on another phone) shows the total
 * and the payment method only. The total is always the order's own `total_npr`.
 */
export function BillDetails({
  receipt,
  serverTotalNpr,
  paymentMethod,
}: {
  receipt: OrderReceipt | undefined;
  /** What the server charged (`total_npr`). */
  serverTotalNpr: number;
  paymentMethod: PaymentMethod;
}) {
  const { t } = useTranslation();

  return (
    <View className="gap-2 rounded-2xl bg-white p-4 shadow-sm" testID="bill-details">
      <Text className="pb-1 text-base font-bold text-gray-900">{t('bill.title')}</Text>
      {receipt === undefined ? null : (
        <>
          <Row
            label={t('bill.itemTotal')}
            value={t('common.price', { amount: receipt.subtotalNpr })}
            testID="bill-item-total"
          />
          {receipt.vendorOfferDiscountNpr > 0 ? (
            <Row
              tone="discount"
              label={withLabel(t('bill.shopDiscount'), receipt.vendorOfferLabel)}
              value={t('cart.discountAmount', { amount: receipt.vendorOfferDiscountNpr })}
              testID="bill-shop-discount"
            />
          ) : null}
          {receipt.platformPromoDiscountNpr > 0 ? (
            <Row
              tone="discount"
              label={withLabel(t('bill.promoDiscount'), receipt.platformPromoLabel)}
              value={t('cart.discountAmount', { amount: receipt.platformPromoDiscountNpr })}
              testID="bill-promo-discount"
            />
          ) : null}
          <Row
            label={t('bill.deliveryFee')}
            value={t('common.price', { amount: receipt.deliveryFeeNpr })}
            testID="bill-delivery-fee"
          />
          <Row
            label={t('bill.platformFee')}
            value={t('common.price', { amount: receipt.platformFeeNpr })}
            testID="bill-platform-fee"
          />
          <View className="my-1 h-px bg-gray-200" />
        </>
      )}
      <Row
        tone="total"
        label={t('bill.total')}
        value={t('common.price', { amount: serverTotalNpr })}
        testID="bill-total"
      />
      <Row
        label={t('bill.paymentMethod')}
        value={t(`payment.${paymentMethod}`)}
        testID="bill-payment-method"
      />
    </View>
  );
}
