import { router } from 'expo-router';
import { Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { Button } from '../../components/Button';
import { formatCountdown, remainingMs, useNow } from '../../lib/countdown';
import { useAuthStore } from '../../store/useAuthStore';
import { selectIsCheckoutPending, useCheckoutStore } from '../../store/useCheckoutStore';

/** "Session Expired" (SPEC §3): the lock lapsed and the cart was purged. */
export function SessionExpiredNotice() {
  const { t } = useTranslation();
  const sessionExpired = useCheckoutStore((state) => state.sessionExpired);
  const dismiss = useCheckoutStore((state) => state.dismissSessionExpired);
  if (!sessionExpired) return null;

  return (
    <View className="mx-4 mt-4 gap-3 rounded-2xl bg-red-50 p-4" testID="session-expired">
      <Text className="text-lg font-bold text-red-800">{t('checkout.sessionExpiredTitle')}</Text>
      <Text className="text-sm text-red-800">{t('checkout.sessionExpiredMessage')}</Text>
      <Button label={t('checkout.dismiss')} variant="secondary" size="sm" onPress={dismiss} />
    </View>
  );
}

/** Countdown for a reservation that is waiting for payment. */
export function ReservationCountdown() {
  const pending = useCheckoutStore(selectIsCheckoutPending);
  const expiresAt = useCheckoutStore((state) => state.session?.expiresAt ?? null);
  return pending ? <LiveCountdown expiresAt={expiresAt} /> : null;
}

/** Mounted only while pending, so its once-per-second clock runs only then. */
function LiveCountdown({ expiresAt }: { expiresAt: string | null }) {
  const { t } = useTranslation();
  const locale = useAuthStore((state) => state.locale);
  const left = remainingMs(expiresAt, useNow());
  return (
    <View className="gap-1 rounded-2xl bg-amber-50 p-4" testID="reservation-countdown">
      <Text className="text-base font-bold text-amber-900">{t('checkout.reservedTitle')}</Text>
      <Text className="text-sm text-amber-900">
        {left > 0
          ? t('checkout.reservedCountdown', { time: formatCountdown(left, locale) })
          : t('checkout.awaitingConfirmation')}
      </Text>
      <Text className="text-xs text-amber-800">{t('cart.locked')}</Text>
    </View>
  );
}

/** Outcome of a finished checkout: placed (with the delivery OTP) or failed. */
export function CheckoutOutcome() {
  const { t } = useTranslation();
  const session = useCheckoutStore((state) => state.session);
  const deliveryOtp = useCheckoutStore((state) => state.deliveryOtp);
  const endSession = useCheckoutStore((state) => state.endSession);
  if (session === null || session.orderState === 'PENDING_PAYMENT') return null;

  const placed = session.orderState !== 'FAILED' && session.orderState !== 'CANCELED';
  return (
    <View
      className={`mx-4 mt-4 gap-2 rounded-2xl p-4 ${placed ? 'bg-emerald-50' : 'bg-red-50'}`}
      testID="checkout-outcome"
    >
      <Text className={`text-lg font-bold ${placed ? 'text-emerald-900' : 'text-red-800'}`}>
        {placed ? t('checkout.placedTitle') : t('checkout.failedTitle')}
      </Text>
      {placed && deliveryOtp !== null ? (
        <>
          <Text className="text-base font-semibold text-emerald-900">
            {t('checkout.deliveryCode', { otp: deliveryOtp })}
          </Text>
          <Text className="text-sm text-emerald-900">{t('checkout.deliveryCodeHint')}</Text>
        </>
      ) : null}
      {placed ? (
        <Button
          label={t('order.track')}
          size="sm"
          onPress={() => {
            router.push({ pathname: '/track-order', params: { id: session.orderId } });
          }}
        />
      ) : null}
      <Button label={t('checkout.dismiss')} variant="secondary" size="sm" onPress={endSession} />
    </View>
  );
}
