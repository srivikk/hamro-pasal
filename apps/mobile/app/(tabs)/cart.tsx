import type { PaymentMethod } from '@hamro-pasal/shared-types';
import { useState } from 'react';
import { FlatList, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import type { ApiError } from '../../src/api/http';
import { useCheckout } from '../../src/api/mutations';
import { Button } from '../../src/components/Button';
import { PaymentWebViewModal } from '../../src/components/PaymentWebViewModal';
import { computeCartSummary } from '../../src/features/cart/cart-summary';
import {
  CheckoutOutcome,
  ReservationCountdown,
  SessionExpiredNotice,
} from '../../src/features/checkout/CheckoutStatus';
import { PaymentMethodPicker } from '../../src/features/checkout/PaymentMethodPicker';
import { usePaymentFlow } from '../../src/features/payment/usePaymentFlow';
import { formatLocalizedNumber } from '../../src/i18n/format-number';
import { toNpr, toPaisa } from '../../src/lib/money';
import { useAuthStore } from '../../src/store/useAuthStore';
import { MAX_LINE_QUANTITY, useCartStore, useItemCount } from '../../src/store/useCartStore';
import { selectIsCheckoutPending, useCheckoutStore } from '../../src/store/useCheckoutStore';

const KNOWN_CHECKOUT_ERRORS = [
  'NOT_SIGNED_IN',
  'UNAUTHENTICATED',
  'NETWORK_ERROR',
  'INSUFFICIENT_STOCK',
  'BELOW_MINIMUM_ORDER_VALUE',
  'COD_NOT_AVAILABLE',
  'VENDOR_UNAVAILABLE',
  'PRODUCT_UNAVAILABLE',
  'CHECKOUT_IN_PROGRESS',
  'CHECKOUT_BUSY',
] as const;
type KnownCheckoutError = (typeof KNOWN_CHECKOUT_ERRORS)[number];

function isKnownCheckoutError(code: string): code is KnownCheckoutError {
  return (KNOWN_CHECKOUT_ERRORS as readonly string[]).includes(code);
}

function SummaryRow({
  label,
  value,
  strong = false,
}: {
  label: string;
  value: string;
  strong?: boolean;
}) {
  return (
    <View className="flex-row justify-between">
      <Text
        className={strong ? 'text-base font-bold text-neutral-900' : 'text-sm text-neutral-700'}
      >
        {label}
      </Text>
      <Text className={strong ? 'text-lg font-bold text-neutral-900' : 'text-sm text-neutral-900'}>
        {value}
      </Text>
    </View>
  );
}

export default function CartScreen() {
  const { t } = useTranslation();
  const locale = useAuthStore((state) => state.locale);
  const vendor = useCartStore((state) => state.vendor);
  const lines = useCartStore((state) => state.lines);
  const setQuantity = useCartStore((state) => state.setQuantity);
  const clearCart = useCartStore((state) => state.clearCart);
  const itemCount = useItemCount();
  const checkoutPending = useCheckoutStore(selectIsCheckoutPending);
  const checkout = useCheckout();
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('ESEWA');
  const session = useCheckoutStore((state) => state.session);
  const payment = usePaymentFlow();

  const paymentModal = (
    <PaymentWebViewModal
      target={payment.target}
      onRedirect={payment.handleRedirect}
      onCancel={payment.cancel}
    />
  );

  const errorMessage = (error: ApiError | null): string | null => {
    // A lapsed reservation is reported by the Session Expired notice instead.
    if (error === null || error.code === 'RESERVATION_EXPIRED') return null;
    return isKnownCheckoutError(error.code)
      ? t(`checkout.errors.${error.code}`)
      : t('checkout.errors.generic');
  };

  if (vendor === null) {
    return (
      <View className="flex-1 bg-neutral-50">
        <SessionExpiredNotice />
        <CheckoutOutcome />
        <View className="flex-1 items-center justify-center px-6">
          <Text className="text-base text-neutral-600">{t('cart.empty')}</Text>
        </View>
        {paymentModal}
      </View>
    );
  }

  const summary = computeCartSummary(vendor, lines);
  // While a reservation waits for payment (or the checkout call is in flight), the cart is frozen.
  const locked = checkoutPending || checkout.isPending;
  const error = errorMessage(checkout.error);

  return (
    <View className="flex-1 bg-neutral-50">
      <FlatList
        data={lines}
        keyExtractor={(line) => line.productId}
        ListHeaderComponent={
          <>
            <SessionExpiredNotice />
            <CheckoutOutcome />
            <Text className="px-4 pb-2 pt-4 text-lg font-bold text-neutral-900">
              {t('cart.from', { vendor: vendor.name })}
            </Text>
          </>
        }
        renderItem={({ item: line }) => (
          <View
            testID={`cart-line-${line.productId}`}
            className="mx-4 mb-3 flex-row items-center rounded-2xl border border-neutral-200 bg-white p-4"
          >
            <View className="flex-1">
              <Text className="text-base font-semibold text-neutral-900">{line.name}</Text>
              <Text className="mt-1 text-sm text-neutral-600">
                {t('common.price', { amount: line.unitPriceNpr })}
              </Text>
            </View>
            <View className="flex-row items-center gap-2">
              <Button
                label="−"
                size="sm"
                variant="secondary"
                disabled={locked}
                accessibilityLabel={t('cart.decrease', { name: line.name })}
                onPress={() => {
                  setQuantity(line.productId, line.quantity - 1);
                }}
              />
              <Text className="min-w-6 text-center text-base font-semibold text-neutral-900">
                {formatLocalizedNumber(line.quantity, locale)}
              </Text>
              <Button
                label="+"
                size="sm"
                variant="secondary"
                disabled={locked || line.quantity >= MAX_LINE_QUANTITY}
                accessibilityLabel={t('cart.increase', { name: line.name })}
                onPress={() => {
                  setQuantity(line.productId, line.quantity + 1);
                }}
              />
            </View>
            <Text className="ml-3 min-w-20 text-right text-base font-semibold text-neutral-900">
              {t('common.price', { amount: toNpr(toPaisa(line.unitPriceNpr) * line.quantity) })}
            </Text>
          </View>
        )}
      />

      <View className="gap-3 border-t border-neutral-200 bg-white p-4" testID="cart-summary">
        <SummaryRow
          label={`${t('cart.subtotal')} · ${t('cart.itemCount', { count: itemCount })}`}
          value={t('common.price', { amount: summary.subtotalNpr })}
        />
        <SummaryRow
          label={t('cart.deliveryFee')}
          value={t('common.price', { amount: summary.deliveryFeeNpr })}
        />
        <SummaryRow
          label={t('cart.platformFee')}
          value={t('common.price', { amount: summary.platformFeeNpr })}
        />
        <SummaryRow
          strong
          label={t('cart.total')}
          value={t('common.price', { amount: summary.totalNpr })}
        />

        {summary.shortOfMinimumNpr > 0 ? (
          <Text className="text-sm text-amber-800" testID="below-minimum">
            {t('cart.belowMinimum', { amount: summary.shortOfMinimumNpr })}
          </Text>
        ) : null}

        {checkoutPending && session !== null ? (
          <>
            <ReservationCountdown />
            {session.paymentMethod === 'COD' ? null : (
              <Button
                label={
                  payment.isConfirming
                    ? t('paymentFlow.confirming')
                    : t('paymentFlow.payNow', { method: t(`payment.${session.paymentMethod}`) })
                }
                disabled={payment.isStarting || payment.isConfirming}
                onPress={() => {
                  if (session.paymentMethod !== 'COD') {
                    payment.start(session.orderId, session.paymentMethod);
                  }
                }}
              />
            )}
          </>
        ) : (
          <>
            <PaymentMethodPicker
              value={paymentMethod}
              onChange={setPaymentMethod}
              disabled={checkout.isPending}
            />
            {error === null ? null : (
              <Text className="text-sm text-red-700" testID="checkout-error">
                {error}
              </Text>
            )}
            <Button
              label={t('cart.proceed')}
              disabled={checkout.isPending || summary.shortOfMinimumNpr > 0}
              onPress={() => {
                checkout.mutate(paymentMethod, {
                  // Prepaid orders wait in PENDING_PAYMENT: open the gateway straight away.
                  onSuccess: ({ order }) => {
                    if (order.state === 'PENDING_PAYMENT' && order.payment_method !== 'COD') {
                      payment.start(order.id, order.payment_method);
                    }
                  },
                });
              }}
            />
            <Button
              label={t('cart.clear')}
              variant="danger"
              disabled={checkout.isPending}
              onPress={clearCart}
            />
          </>
        )}
      </View>
      {paymentModal}
    </View>
  );
}
