import { useRef, useState } from 'react';
import { ActivityIndicator, Modal, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { SafeAreaView } from 'react-native-safe-area-context';
import { WebView, type WebViewNavigation } from 'react-native-webview';

import {
  interpretNavigation,
  type PaymentRedirect,
  type PaymentTarget,
} from '../features/payment/payment-redirect';
import { Button } from './Button';

export interface PaymentWebViewModalProps {
  /** What to load; null closes the modal. */
  target: PaymentTarget | null;
  /** Called once per target, with the first callback redirect (success, return or failure). */
  onRedirect: (target: PaymentTarget, redirect: Exclude<PaymentRedirect, { kind: 'none' }>) => void;
  /** The customer closed the payment page before any callback. */
  onCancel: (target: PaymentTarget) => void;
}

/** A new session (fresh interception state and spinner) per payment attempt. */
function sessionKey(target: PaymentTarget): string {
  return target.method === 'KHALTI'
    ? `KHALTI:${target.pidx}`
    : `ESEWA:${target.orderId}:${target.html}`;
}

function PaymentSession({
  target,
  onRedirect,
  onCancel,
}: PaymentWebViewModalProps & { target: PaymentTarget }) {
  const { t } = useTranslation();
  // Navigation events keep arriving while the modal animates away; only the first callback counts.
  const intercepted = useRef(false);
  const [loading, setLoading] = useState(true);

  const onNavigationStateChange = ({ url }: WebViewNavigation): void => {
    if (intercepted.current) return;
    const redirect = interpretNavigation(target, url);
    if (redirect.kind === 'none') return;
    intercepted.current = true;
    onRedirect(target, redirect);
  };

  return (
    <SafeAreaView className="flex-1 bg-white">
      <View className="flex-row items-center justify-between border-b border-neutral-200 px-4 py-3">
        <Text className="text-base font-bold text-neutral-900">
          {t('paymentFlow.title', { method: t(`payment.${target.method}`) })}
        </Text>
        <Button
          label={t('paymentFlow.cancel')}
          size="sm"
          variant="secondary"
          onPress={() => {
            if (intercepted.current) return;
            intercepted.current = true;
            onCancel(target);
          }}
        />
      </View>
      <View className="flex-1">
        <WebView
          testID="payment-webview"
          source={target.method === 'ESEWA' ? { html: target.html } : { uri: target.paymentUrl }}
          onNavigationStateChange={onNavigationStateChange}
          onLoadEnd={() => {
            setLoading(false);
          }}
          // The gateway pages run in a fresh, isolated session and cannot open extra windows.
          incognito
          setSupportMultipleWindows={false}
          javaScriptEnabled
        />
        {loading ? (
          <View className="absolute inset-0 items-center justify-center bg-white">
            <ActivityIndicator testID="payment-webview-loading" />
          </View>
        ) : null}
      </View>
    </SafeAreaView>
  );
}

/**
 * Full-screen gateway page for eSewa (auto-submitted signed form) and Khalti (payment_url). It
 * reports the first callback redirect and leaves confirming the payment to the caller.
 */
export function PaymentWebViewModal({ target, onRedirect, onCancel }: PaymentWebViewModalProps) {
  return (
    <Modal
      visible={target !== null}
      animationType="slide"
      presentationStyle="fullScreen"
      onRequestClose={() => {
        if (target !== null) onCancel(target);
      }}
    >
      {target === null ? null : (
        <PaymentSession
          key={sessionKey(target)}
          target={target}
          onRedirect={onRedirect}
          onCancel={onCancel}
        />
      )}
    </Modal>
  );
}
