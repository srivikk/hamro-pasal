import type { PaymentMethod } from '@hamro-pasal/shared-types';
import { Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import type { OrderReceipt } from '../../store/useOrderReceiptStore';
import { demoTotalNpr, receiptMockSavingsNpr } from '../promo/demo-pricing';

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

/**
 * "Bill Details" of an order: item total, delivery fee, platform fee, shop discount, the final
 * total and how it was paid. The layout is the one the discount engine will fill
 * (SPEC "Checkout and Cart Math Protocol": total = subtotal - discounts + delivery fee).
 *
 * The amounts come from the receipt this phone kept at checkout. An order without one (placed on
 * another phone) shows the total and the payment method only.
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
  // TODO: Remove mock pricing when /cart/quote is ready.
  // The Shop Discount row and the total below it use the MOCK discount the cart displayed (demo
  // only; the server charged `serverTotalNpr`). Replace both with the order's own discount lines
  // (vendor_offer_discount, platform_promo_discount) and total once the API returns them.
  // The same holds for a delivery fee the cart showed as free ("Free delivery" label).
  const discountNpr = receipt?.shopDiscountNpr ?? 0;
  const finalTotalNpr = demoTotalNpr(serverTotalNpr, receiptMockSavingsNpr(receipt));
  // Shown only where the mock pricing is on (development builds): elsewhere the total is the server's.
  const discountShown = demoTotalNpr(serverTotalNpr, discountNpr) !== serverTotalNpr;
  const deliveryFree =
    demoTotalNpr(serverTotalNpr, receipt?.deliveryDiscountNpr) !== serverTotalNpr;

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
          <Row
            tone={deliveryFree ? 'discount' : 'plain'}
            label={t('bill.deliveryFee')}
            value={
              deliveryFree ? t('cart.free') : t('common.price', { amount: receipt.deliveryFeeNpr })
            }
            testID="bill-delivery-fee"
          />
          <Row
            label={t('bill.platformFee')}
            value={t('common.price', { amount: receipt.platformFeeNpr })}
            testID="bill-platform-fee"
          />
          {discountShown ? (
            <Row
              tone="discount"
              label={
                receipt.shopOfferLabel === null
                  ? t('bill.shopDiscount')
                  : `${t('bill.shopDiscount')} · ${receipt.shopOfferLabel}`
              }
              value={t('cart.discountAmount', { amount: discountNpr })}
              testID="bill-shop-discount"
            />
          ) : null}
          <View className="my-1 h-px bg-gray-200" />
        </>
      )}
      <Row
        tone="total"
        label={t('bill.total')}
        value={t('common.price', { amount: finalTotalNpr })}
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
