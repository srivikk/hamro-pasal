import type { PaymentMethod } from '@hamro-pasal/shared-types';
import { router, Stack } from 'expo-router';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useEffect, useEffectEvent, useState } from 'react';
import { Alert, FlatList, Pressable, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useAbandonCheckout } from '../src/api/abandon-checkout';
import { ApiError } from '../src/api/http';
import { useCheckout } from '../src/api/mutations';
import { Button } from '../src/components/Button';
import { ConfirmModal } from '../src/components/ConfirmModal';
import { PaymentWebViewModal } from '../src/components/PaymentWebViewModal';
import { AddressBookModal } from '../src/features/address/AddressBookModal';
import { DeliveryAddressCard } from '../src/features/address/DeliveryAddressCard';
import { useDeliveryAreaCheck } from '../src/features/checkout/delivery-area';
import { DeliveryAreaModal } from '../src/features/checkout/DeliveryAreaModal';
import { CUSTOMER_PLATFORM_FEE_NPR } from '../src/features/cart/cart-summary';
import { cartTotals } from '../src/features/cart/cart-totals';
import { useCartQuote } from '../src/features/cart/useCartQuote';
import { checkoutRefusalDialog, isDialogRefusal } from '../src/features/checkout/checkout-refusals';
import { vendorExtras } from '../src/features/promo/mock-promotions';
import {
  CheckoutOutcome,
  ReservationCountdown,
  SessionExpiredNotice,
} from '../src/features/checkout/CheckoutStatus';
import { usePaymentChoiceStore, type PaymentChoice } from '../src/features/checkout/payment-choice';
import { usePaymentFlow } from '../src/features/payment/usePaymentFlow';
import { useCurrentProfile } from '../src/features/profile/profile-form';
import { formatLocalizedNumber } from '../src/i18n/format-number';
import { toNpr, toPaisa } from '../src/lib/money';
import { formatAddressLine } from '../src/features/address/address-form';
import { useAddressStore } from '../src/store/useAddressStore';
import { useOrderReceiptStore } from '../src/store/useOrderReceiptStore';
import { selectHasSession, useAuthStore } from '../src/store/useAuthStore';
import {
  isOverStock,
  maxLineQuantity,
  useCartStore,
  useItemCount,
} from '../src/store/useCartStore';
import { selectIsCheckoutPending, useCheckoutStore } from '../src/store/useCheckoutStore';
import { useToastStore } from '../src/store/useToastStore';
import { colors } from '../src/theme/colors';

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
  'OUTSIDE_DELIVERY_AREA',
  'DELIVERY_UNAVAILABLE',
] as const;
type KnownCheckoutError = (typeof KNOWN_CHECKOUT_ERRORS)[number];

function isKnownCheckoutError(code: string): code is KnownCheckoutError {
  return (KNOWN_CHECKOUT_ERRORS as readonly string[]).includes(code);
}

function SummaryRow({
  label,
  value,
  strong = false,
  discount = false,
  testID,
}: {
  label: string;
  value: string;
  strong?: boolean;
  /** A deduction: both texts in green. */
  discount?: boolean;
  testID?: string;
}) {
  const labelStyle = strong
    ? 'text-base font-bold text-gray-900'
    : discount
      ? 'text-sm font-semibold text-green-700'
      : 'text-sm text-gray-700';
  const valueStyle = strong
    ? 'text-lg font-bold text-gray-900'
    : discount
      ? 'text-sm font-semibold text-green-700'
      : 'text-sm text-gray-900';
  return (
    <View className="flex-row justify-between" testID={testID}>
      <Text className={labelStyle}>{label}</Text>
      <Text className={valueStyle}>{value}</Text>
    </View>
  );
}

/**
 * Picks up the payment method chosen on the Payment Options screen and hands it to the cart,
 * once. A component of its own because the cart can only start a checkout while it has items.
 */
function PaymentChoiceRunner({ onChosen }: { onChosen: (choice: PaymentChoice) => void }) {
  const chosen = usePaymentChoiceStore((state) => state.chosen);
  const clear = usePaymentChoiceStore((state) => state.clear);
  const run = useEffectEvent(onChosen);
  useEffect(() => {
    if (chosen === null) return;
    clear();
    run(chosen);
  }, [chosen, clear]);
  return null;
}

/**
 * The cart is a screen of the root stack, not a tab: opening it covers the bottom tab bar, and
 * the stack header's back arrow returns to the shop or the feed it was opened from.
 */
export default function CartScreen() {
  const { t } = useTranslation();
  const { bottom } = useSafeAreaInsets();
  const locale = useAuthStore((state) => state.locale);
  const vendor = useCartStore((state) => state.vendor);
  const lines = useCartStore((state) => state.lines);
  const setQuantity = useCartStore((state) => state.setQuantity);
  const clearCart = useCartStore((state) => state.clearCart);
  const itemCount = useItemCount();
  const checkoutPending = useCheckoutStore(selectIsCheckoutPending);
  const checkout = useCheckout();
  const session = useCheckoutStore((state) => state.session);
  const payment = usePaymentFlow();
  const hasAddress = useAddressStore((state) => state.address !== null);
  const signedIn = useAuthStore(selectHasSession);
  const profileComplete = useCurrentProfile() !== null;
  const areaCheck = useDeliveryAreaCheck();
  const abandon = useAbandonCheckout();
  const showToast = useToastStore((state) => state.show);
  const [outOfArea, setOutOfArea] = useState(false);
  const [areaCheckFailed, setAreaCheckFailed] = useState(false);
  const [addressBookOpen, setAddressBookOpen] = useState(false);
  const [clearOpen, setClearOpen] = useState(false);
  // The server's price for this cart: its discounts, delivery charge, total and payment methods.
  const quote = useCartQuote({ frozen: checkoutPending || checkout.isPending });

  const header = (
    <Stack.Screen
      options={{ headerShown: true, title: t('tabs.cart'), headerBackTitle: t('common.back') }}
    />
  );
  const paymentModal = (
    <PaymentWebViewModal
      target={payment.target}
      onRedirect={payment.handleRedirect}
      onCancel={payment.cancel}
    />
  );

  const errorMessage = (error: ApiError | null): string | null => {
    // A lapsed reservation is reported by the Session Expired notice instead; a changed quote
    // and a refused payment method by their own dialogs.
    if (error === null || error.code === 'RESERVATION_EXPIRED' || isDialogRefusal(error.code)) {
      return null;
    }
    return isKnownCheckoutError(error.code)
      ? t(`checkout.errors.${error.code}`)
      : t('checkout.errors.generic');
  };

  if (vendor === null) {
    return (
      <View className="flex-1 bg-gray-50">
        {header}
        <SessionExpiredNotice />
        <CheckoutOutcome />
        <View className="flex-1 items-center justify-center px-6">
          <Text className="text-base text-gray-500">{t('cart.empty')}</Text>
        </View>
        {paymentModal}
      </View>
    );
  }

  // The bill: the server's quote once it has answered, the device's estimate until then.
  const bill = cartTotals(vendor, lines, quote.data);
  const { summary } = bill;
  // While a reservation waits for payment (or the checkout call is in flight), the cart is frozen.
  const locked = checkoutPending || checkout.isPending || areaCheck.isPending;
  const error = areaCheckFailed
    ? t('checkout.errors.NETWORK_ERROR')
    : (errorMessage(checkout.error) ??
      errorMessage(quote.error instanceof ApiError ? quote.error : null));

  const placeOrder = (method: PaymentMethod, expectedTotalNpr: number | null): void => {
    checkout.mutate(
      { paymentMethod: method, expectedTotalNpr },
      {
        // An offer that ended, or a payment method the shop no longer takes: say so in a dialog
        // that offers the way forward. No order was created, and the quote is being fetched again.
        onError: (refusal) => {
          const dialog = checkoutRefusalDialog(
            t,
            refusal,
            { paymentMethod: method, expectedTotalNpr },
            {
              acceptTotal: (totalNpr) => {
                placeOrder(method, totalNpr);
              },
              chooseAnotherMethod: () => {
                router.push('/checkout/payment-options');
              },
            },
          );
          if (dialog !== null) Alert.alert(dialog.title, dialog.message, dialog.buttons);
        },
        // Prepaid orders wait in PENDING_PAYMENT: open the gateway straight away.
        onSuccess: ({ order }) => {
          // Keep what this cart held as the order's receipt: the order history, the bill and
          // "Reorder" read it (the API's order carries no shop name and has no list endpoint).
          const address = useAddressStore.getState().address;
          useOrderReceiptStore.getState().saveReceipt({
            orderId: order.id,
            placedAtMs: Date.now(),
            vendor,
            vendorLocation: vendorExtras({ id: vendor.id, business_name: vendor.name }).locality,
            items: lines.map((line) => ({
              productId: line.productId,
              name: line.name,
              unitPriceNpr: line.unitPriceNpr,
              quantity: line.quantity,
            })),
            subtotalNpr: order.subtotal_npr,
            deliveryFeeNpr: order.delivery_fee_npr,
            platformFeeNpr: CUSTOMER_PLATFORM_FEE_NPR,
            // The discounts as the server applied them to this order, with the quote's labels.
            vendorOfferDiscountNpr: order.vendor_offer_discount_npr,
            vendorOfferLabel:
              order.vendor_offer_discount_npr > 0 ? (bill.vendorOffer?.label ?? null) : null,
            platformPromoDiscountNpr: order.platform_promo_discount_npr,
            platformPromoLabel:
              order.platform_promo_discount_npr > 0 ? (bill.platformPromo?.label ?? null) : null,
            deliveryAddress:
              address === null
                ? null
                : `${address.landmark}, ${formatAddressLine(address, String(address.ward_number))}`,
          });
          if (order.state === 'PENDING_PAYMENT' && order.payment_method !== 'COD') {
            payment.start(order.id, order.payment_method);
          }
        },
      },
    );
  };
  // SPEC §2: the shop must deliver to the delivery address (not merely to where the customer was
  // browsing). The server's own serviceability answer for that address decides.
  const proceed = ({ method, expectedTotalNpr }: PaymentChoice): void => {
    setAreaCheckFailed(false);
    areaCheck.mutate(vendor.id, {
      onSuccess: (verdict) => {
        if (verdict === 'not_serviceable') setOutOfArea(true);
        else if (verdict === 'unknown') setAreaCheckFailed(true);
        else placeOrder(method, expectedTotalNpr);
      },
    });
  };
  const hasOverStock = lines.some(isOverStock);
  // SPEC Nepal localizations §3: no checkout without a valid delivery address. A line above the
  // stock the server reported would only be refused again. Signed in, with a name on the profile.
  const canProceed =
    signedIn &&
    profileComplete &&
    !locked &&
    summary.shortOfMinimumNpr === 0 &&
    hasAddress &&
    !hasOverStock;
  // Step two needs a price to agree to and a way to pay: the quote, with delivery available.
  const deliveryOff = quote.data?.delivery_available === false;
  const canPay = canProceed && quote.data !== undefined && !deliveryOff;
  // Editing the cart answers the last refusal (stock, minimum order...): its message goes away.
  const changeQuantity = (productId: string, quantity: number): void => {
    setQuantity(productId, quantity);
    if (checkout.isError) checkout.reset();
  };

  const footer = (
    <View className="gap-3 pb-4 pt-2">
      <View className="gap-3 bg-white p-4" testID="cart-summary">
        <Text className="text-base font-bold text-gray-900">{t('bill.title')}</Text>
        <SummaryRow
          label={`${t('cart.subtotal')} · ${t('cart.itemCount', { count: itemCount })}`}
          value={t('common.price', { amount: bill.subtotalNpr })}
        />
        {/* The server's discounts, in the order it applied them: the shop's own offer on the
            subtotal, then the platform promotion on what is left. Each on its own line. */}
        {bill.vendorOffer === null ? null : (
          <SummaryRow
            discount
            testID="cart-shop-discount"
            label={`${t('cart.shopDiscount')} · ${bill.vendorOffer.label}`}
            value={t('cart.discountAmount', { amount: bill.vendorOffer.discountNpr })}
          />
        )}
        {bill.platformPromo === null ? null : (
          <SummaryRow
            discount
            testID="cart-promo-discount"
            label={`${t('cart.promoDiscount')} · ${bill.platformPromo.label}`}
            value={t('cart.discountAmount', { amount: bill.platformPromo.discountNpr })}
          />
        )}
        <SummaryRow
          testID="cart-delivery-fee"
          label={t('cart.deliveryFee')}
          value={t('common.price', { amount: bill.deliveryFeeNpr })}
        />
        <SummaryRow
          label={t('cart.platformFee')}
          value={t('common.price', { amount: summary.platformFeeNpr })}
        />
        <SummaryRow
          strong
          testID="cart-total"
          label={t(bill.quoted ? 'cart.total' : 'cart.estimatedTotal')}
          value={t('common.price', { amount: bill.totalNpr })}
        />
        {bill.savedNpr > 0 ? (
          <Text className="text-sm font-semibold text-green-700" testID="cart-saved">
            {t('paymentOptions.saved', { amount: bill.savedNpr })}
          </Text>
        ) : null}
        {deliveryOff ? (
          <Text className="text-sm font-semibold text-red-700" testID="cart-delivery-unavailable">
            {t('cart.deliveryUnavailable')}
          </Text>
        ) : null}

        {summary.shortOfMinimumNpr > 0 ? (
          <Text className="text-sm text-amber-800" testID="below-minimum">
            {t('cart.belowMinimum', { amount: summary.shortOfMinimumNpr })}
          </Text>
        ) : null}
      </View>

      {/* Back to the menu of the shop this cart is from. Not while the cart is frozen. */}
      {locked ? null : (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('cart.addMore')}
          testID="cart-add-more"
          className="mx-4 flex-row items-center justify-center gap-2 rounded-xl border border-dashed border-brand bg-white py-3 active:opacity-70"
          onPress={() => {
            // The cart sits above the tabs: go back down to the Shops tab and open the shop
            // there, rather than stacking a second copy of the tabs on top of the cart.
            router.dismissTo({ pathname: '/vendor/[id]', params: { id: vendor.id } });
          }}
        >
          <Ionicons name="add" size={18} color={colors.brand} />
          <Text className="text-sm font-bold text-brand">{t('cart.addMore')}</Text>
        </Pressable>
      )}

      {/* A guest sees the items and the totals only: where to deliver is asked after sign-in
          (and nothing saved on this phone is shown to a signed-out visitor). */}
      {signedIn && !checkoutPending ? (
        <View className="gap-2 px-4">
          <DeliveryAddressCard disabled={checkout.isPending} />
          {hasAddress ? null : (
            <Text className="text-sm text-amber-800" testID="address-required">
              {t('cart.addressRequired')}
            </Text>
          )}
        </View>
      ) : null}

      {checkoutPending ? null : (
        <View className="px-4">
          <Button
            label={t('cart.clear')}
            variant="danger"
            disabled={checkout.isPending}
            onPress={() => {
              // Emptying the cart cannot be undone: ask first, in the app's own dialog.
              setClearOpen(true);
            }}
          />
        </View>
      )}
    </View>
  );

  return (
    <View className="flex-1 bg-gray-50">
      {header}
      <FlatList
        data={lines}
        keyExtractor={(line) => line.productId}
        ListFooterComponent={footer}
        ListHeaderComponent={
          <>
            <SessionExpiredNotice />
            <CheckoutOutcome />
            <Text className="px-4 pb-2 pt-4 text-lg font-bold text-gray-900">
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
                overStock ? 'border-red-500 bg-red-50' : 'border-gray-200 bg-white'
              }`}
            >
              <View className="flex-row items-center">
                <View className="flex-1">
                  <Text className="text-base font-semibold text-gray-900">{line.name}</Text>
                  <Text className="mt-1 text-sm text-gray-500">
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
                  <Text className="min-w-6 text-center text-base font-semibold text-gray-900">
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
                <Text className="ml-3 min-w-20 text-right text-base font-semibold text-gray-900">
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

      {/* Outside the tabs nothing pads the home indicator: the action bar does it itself. */}
      <View
        className="gap-3 border-t border-gray-200 bg-white px-4 pt-4"
        style={{ paddingBottom: bottom + 16 }}
        testID="cart-actions"
      >
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
            {/* The way out when the payment page will not open: gives the order up, stops the
                countdown and unlocks the cart. Not while a payment is being confirmed. */}
            <Button
              label={abandon.isPending ? t('cart.cancellingPayment') : t('cart.cancelPayment')}
              variant="danger"
              testID="cancel-payment"
              disabled={abandon.isPending || payment.isConfirming}
              onPress={() => {
                abandon.mutate(session.orderId, {
                  onSuccess: (outcome) => {
                    if (outcome === 'already_paid') showToast(t('cart.paymentAlreadyDone'), 'info');
                    else {
                      checkout.reset();
                      showToast(t('cart.paymentCancelled'), 'info');
                    }
                  },
                });
              }}
            />
          </>
        ) : (
          <>
            {error === null ? null : (
              <Text className="text-sm text-red-700" testID="checkout-error">
                {error}
              </Text>
            )}
            {quote.isError && checkout.error === null && !areaCheckFailed ? (
              <Button
                testID="quote-retry"
                label={t('common.retry')}
                variant="secondary"
                size="sm"
                onPress={() => void quote.refetch()}
              />
            ) : null}
            {hasOverStock && error === null ? (
              <Text className="text-sm text-red-700" testID="stock-required">
                {t('cart.fixStock')}
              </Text>
            ) : null}
            {signedIn && !profileComplete ? (
              // Onboarding: an order needs the customer's name first.
              <>
                <Text className="text-sm text-amber-800" testID="profile-required">
                  {t('cart.profileRequired')}
                </Text>
                <Button
                  label={t('cart.completeProfile')}
                  onPress={() => {
                    router.push('/complete-profile');
                  }}
                />
              </>
            ) : signedIn ? (
              // Step one of checkout. The amount is the server's quoted total, the same figure
              // step two shows; how to pay is chosen there. No quote yet: nothing to agree to.
              <Button
                testID="proceed-to-pay"
                label={
                  checkout.isPending || areaCheck.isPending
                    ? t('cart.placingOrder')
                    : canProceed && quote.isFetching && quote.data === undefined
                      ? t('cart.pricing')
                      : t('cart.proceedToPay', { amount: bill.totalNpr })
                }
                disabled={!canPay}
                onPress={() => {
                  router.push('/checkout/payment-options');
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
          </>
        )}
      </View>
      {/* Step two hands the chosen method back; the cart checks it may still proceed. */}
      <PaymentChoiceRunner
        onChosen={(choice) => {
          if (canProceed) proceed(choice);
        }}
      />
      <ConfirmModal
        visible={clearOpen}
        testID="clear-cart-modal"
        icon="trash"
        title={t('cart.clearTitle')}
        message={t('cart.clearMessage')}
        cancelLabel={t('cart.clearCancel')}
        confirmLabel={t('cart.clearConfirm')}
        onCancel={() => {
          setClearOpen(false);
        }}
        onConfirm={() => {
          setClearOpen(false);
          clearCart();
        }}
      />
      {paymentModal}
      <DeliveryAreaModal
        visible={outOfArea}
        vendorName={vendor.name}
        onChangeAddress={() => {
          setOutOfArea(false);
          setAddressBookOpen(true);
        }}
        onClose={() => {
          setOutOfArea(false);
        }}
      />
      <AddressBookModal
        visible={addressBookOpen}
        onClose={() => {
          setAddressBookOpen(false);
        }}
      />
    </View>
  );
}
