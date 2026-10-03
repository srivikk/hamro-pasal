import type { PaymentMethod } from '@hamro-pasal/shared-types';
import { router } from 'expo-router';
import { useState } from 'react';
import { FlatList, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import type { ApiError } from '../../src/api/http';
import { useCheckout } from '../../src/api/mutations';
import { Button } from '../../src/components/Button';
import { PaymentWebViewModal } from '../../src/components/PaymentWebViewModal';
import { DeliveryAddressCard } from '../../src/features/address/DeliveryAddressCard';
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
import { useAddressStore } from '../../src/store/useAddressStore';
import { selectHasSession, useAuthStore } from '../../src/store/useAuthStore';
import {
  isOverStock,
  maxLineQuantity,
  useCartStore,
  useItemCount,
} from '../../src/store/useCartStore';
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
  const hasAddress = useAddressStore((state) => state.address !== null);
  const signedIn = useAuthStore(selectHasSession);

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
  const hasOverStock = lines.some(isOverStock);
  // Editing the cart answers the last refusal (stock, minimum order...): its message goes away.
  const changeQuantity = (productId: string, quantity: number): void => {
    setQuantity(productId, quantity);
    if (checkout.isError) checkout.reset();
  };

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
        renderItem={({ item: line }) => {
          // The server refused this line (409 INSUFFICIENT_STOCK) and said how many are left.
          const overStock = isOverStock(line);
          const left = line.availableStock ?? 0;
          return (
            <View
              testID={`cart-line-${line.productId}`}
              className={`mx-4 mb-3 rounded-2xl border p-4 ${
                overStock ? 'border-red-500 bg-red-50' : 'border-neutral-200 bg-white'
              }`}
            >
              <View className="flex-row items-center">
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
                      changeQuantity(line.productId, line.quantity - 1);
                    }}
                  />
                  <Text className="min-w-6 text-center text-base font-semibold text-neutral-900">
                    {formatLocalizedNumber(line.quantity, locale)}
                  </Text>
                  <Button
                    label="+"
                    size="sm"
                    variant="secondary"
                    disabled={locked || line.quantity >= maxLineQuantity(line.availableStock)}
                    accessibilityLabel={t('cart.increase', { name: line.name })}
                    onPress={() => {
                      changeQuantity(line.productId, line.quantity + 1);
                    }}
                  />
                </View>
                <Text className="ml-3 min-w-20 text-right text-base font-semibold text-neutral-900">
                  {t('common.price', { amount: toNpr(toPaisa(line.unitPriceNpr) * line.quantity) })}
                </Text>
              </View>
              {overStock ? (
                <View className="mt-3 gap-2" testID={`cart-line-stock-${line.productId}`}>
                  <Text className="text-sm font-semibold text-red-700">
                    {left === 0 ? t('cart.soldOut') : t('cart.stockLeft', { count: left })}
                  </Text>
                  <Button
                    label={left === 0 ? t('cart.removeItem') : t('cart.setTo', { count: left })}
                    size="sm"
                    variant="secondary"
                    disabled={locked}
                    accessibilityLabel={
                      left === 0
                        ? t('cart.removeItemNamed', { name: line.name })
                        : t('cart.setToNamed', { name: line.name, count: left })
                    }
                    onPress={() => {
                      changeQuantity(line.productId, left);
                    }}
                  />
                </View>
              ) : null}
            </View>
          );
        }}
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
            <DeliveryAddressCard disabled={checkout.isPending} />
            {hasAddress ? null : (
              <Text className="text-sm text-amber-800" testID="address-required">
                {t('cart.addressRequired')}
              </Text>
            )}
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
            {hasOverStock && error === null ? (
              <Text className="text-sm text-red-700" testID="stock-required">
                {t('cart.fixStock')}
              </Text>
            ) : null}
            {signedIn ? (
              <Button
                label={t('cart.proceed')}
                // SPEC Nepal localizations §3: no checkout without a valid delivery address.
                // A line above the stock the server reported would only be refused again.
                disabled={
                  checkout.isPending || summary.shortOfMinimumNpr > 0 || !hasAddress || hasOverStock
                }
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
            ) : (
              // Signing in returns here (the login screen replaces itself; one step back is the cart).
              <Button
                label={t('cart.signInToCheckout')}
                onPress={() => {
                  router.push('/login');
                }}
              />
            )}
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
