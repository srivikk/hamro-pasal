import Ionicons from '@expo/vector-icons/Ionicons';
import type { PaymentMethod } from '@hamro-pasal/shared-types';
import { Redirect, router, Stack } from 'expo-router';
import { useEffect, useState, type ComponentProps } from 'react';
import { ActivityIndicator, Modal, Pressable, ScrollView, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Button } from '../../src/components/Button';
import { cartTotals } from '../../src/features/cart/cart-totals';
import {
  mockPaymentOptions,
  usePaymentChoiceStore,
  type PaymentOption,
} from '../../src/features/checkout/payment-choice';
import { selectHasSession, useAuthStore } from '../../src/store/useAuthStore';
import { useCartStore } from '../../src/store/useCartStore';
import { colors } from '../../src/theme/colors';

type IconName = ComponentProps<typeof Ionicons>['name'];

/** How long the "Processing…" veil is shown before the choice is handed to the cart. */
export const PAYMENT_PROCESSING_MS = 1500;

/** An icon per known method; a method this build has never heard of gets the generic one. */
const METHOD_ICON: Partial<Record<string, IconName>> = {
  ESEWA: 'wallet',
  KHALTI: 'wallet-outline',
  COD: 'cash',
};

/**
 * Step two of checkout: how to pay. The cart's "Proceed to Pay" opens it with the amount; the
 * customer picks one of the methods the quote offers and confirms. The choice is handed back to
 * the Cart (usePaymentChoiceStore), which runs the checkout it already owns: the delivery-area
 * check, the order, the reservation countdown and the gateway's page.
 *
 * The list is data: whatever `payment_options` the quote returns is rendered, so a new method
 * (cards, bank transfer) needs no change here beyond its label and icon.
 */
export default function PaymentOptionsScreen() {
  const { t } = useTranslation();
  const { bottom } = useSafeAreaInsets();
  const signedIn = useAuthStore(selectHasSession);
  const vendor = useCartStore((state) => state.vendor);
  const lines = useCartStore((state) => state.lines);
  const choose = usePaymentChoiceStore((state) => state.choose);
  // TODO: Replace with backend /cart/quote response (payment_options).
  const options = mockPaymentOptions();
  const [selected, setSelected] = useState<PaymentMethod | null>(
    () => options.find((option) => option.available)?.method ?? null,
  );

  // Confirming shows a full-screen veil for a moment, then hands the choice to the Cart, which is
  // still mounted underneath and runs the real checkout. Leaving the screen first cancels it.
  const [isProcessing, setIsProcessing] = useState(false);
  useEffect(() => {
    if (!isProcessing || selected === null) return undefined;
    const timer = setTimeout(() => {
      choose(selected);
      router.back();
    }, PAYMENT_PROCESSING_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [isProcessing, selected, choose]);

  // Nothing to pay for (the cart was emptied, or the screen was opened directly): back to the cart.
  if (vendor === null || lines.length === 0 || !signedIn) return <Redirect href="/cart" />;

  const { displayedTotalNpr, savedNpr } = cartTotals(vendor, lines);

  const row = (option: PaymentOption) => {
    const chosen = option.method === selected;
    return (
      <Pressable
        key={option.method}
        accessibilityRole="radio"
        accessibilityLabel={t(`payment.${option.method}`)}
        accessibilityState={{ checked: chosen, disabled: !option.available }}
        disabled={!option.available}
        testID={`payment-option-${option.method}`}
        className={`flex-row items-center gap-3 rounded-2xl border-2 bg-white p-4 shadow-sm active:opacity-70 ${
          chosen ? 'border-brand' : 'border-transparent'
        } ${option.available ? '' : 'opacity-50'}`}
        onPress={() => {
          setSelected(option.method);
        }}
      >
        <View className="h-11 w-11 items-center justify-center rounded-xl bg-brand-light">
          <Ionicons name={METHOD_ICON[option.method] ?? 'card'} size={22} color={colors.brand} />
        </View>
        <View className="flex-1">
          <Text className="text-base font-bold text-gray-900">{t(`payment.${option.method}`)}</Text>
          <Text className="text-sm text-gray-500">
            {option.available
              ? t(`paymentOptions.hint.${option.method}`)
              : t('paymentOptions.unavailable')}
          </Text>
        </View>
        <View
          className={`h-5 w-5 items-center justify-center rounded-full border-2 ${
            chosen ? 'border-brand' : 'border-gray-300'
          }`}
        >
          {chosen ? <View className="h-2.5 w-2.5 rounded-full bg-brand" /> : null}
        </View>
      </Pressable>
    );
  };

  return (
    <View className="flex-1 bg-gray-50">
      <Stack.Screen
        options={{
          headerShown: true,
          title: t('paymentOptions.title'),
          headerBackTitle: t('common.back'),
        }}
      />
      <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
        <View className="rounded-2xl bg-white p-4 shadow-sm" testID="payment-amount">
          <Text className="text-sm text-gray-500">
            {t('paymentOptions.toPay', { vendor: vendor.name })}
          </Text>
          <Text className="mt-1 text-2xl font-extrabold text-gray-900">
            {t('common.price', { amount: displayedTotalNpr })}
          </Text>
          {savedNpr > 0 ? (
            <Text className="mt-1 text-sm font-semibold text-green-700">
              {t('paymentOptions.saved', { amount: savedNpr })}
            </Text>
          ) : null}
        </View>

        <Text className="px-1 pt-2 text-xs font-bold uppercase tracking-wide text-gray-500">
          {t('paymentOptions.choose')}
        </Text>
        <View accessibilityRole="radiogroup" className="gap-3">
          {options.map(row)}
        </View>
      </ScrollView>

      <View
        className="border-t border-gray-200 bg-white px-4 pt-3"
        style={{ paddingBottom: bottom + 12 }}
      >
        <Button
          testID="payment-confirm"
          label={
            selected === 'COD'
              ? t('paymentOptions.placeOrder', { amount: displayedTotalNpr })
              : t('paymentOptions.pay', { amount: displayedTotalNpr })
          }
          disabled={selected === null || isProcessing}
          onPress={() => {
            setIsProcessing(true);
          }}
        />
      </View>

      <Modal
        visible={isProcessing}
        transparent
        animationType="fade"
        statusBarTranslucent
        // Android Back does not interrupt the hand-over.
        onRequestClose={() => undefined}
      >
        <View
          className="flex-1 items-center justify-center gap-3 bg-black/50"
          accessibilityRole="progressbar"
          accessibilityLabel={t('paymentOptions.processing')}
          testID="payment-processing"
        >
          <ActivityIndicator size="large" color="#FFFFFF" />
          <Text className="text-base font-semibold text-white">
            {t('paymentOptions.processing')}
          </Text>
        </View>
      </Modal>
    </View>
  );
}
