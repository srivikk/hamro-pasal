import type { PaymentStatusResponseBody } from '@hamro-pasal/shared-types';
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ApiError } from '../../api/http';
import { confirmEsewa, initiateEsewa, initiateKhalti, lookupKhalti } from '../../api/payments';
import { useCheckoutStore } from '../../store/useCheckoutStore';
import { useToastStore } from '../../store/useToastStore';
import {
  esewaTarget,
  khaltiStatusNeedsLookup,
  khaltiTarget,
  type PaymentRedirect,
  type PaymentTarget,
} from './payment-redirect';

export type PrepaidMethod = 'ESEWA' | 'KHALTI';

interface Confirmation {
  orderId: string;
  redirect: Extract<PaymentRedirect, { kind: 'esewa_success' | 'khalti_return' }>;
}

/**
 * Drives one prepaid payment: initiate on the server, show the gateway in the WebView, then
 * forward the callback for server-side verification. The server only learns about the payment
 * through that forward (eSewa webhook / Khalti lookup); useLockStatus then reports the result.
 */
export function usePaymentFlow() {
  const { t } = useTranslation();
  const toast = useToastStore((state) => state.show);
  const [target, setTarget] = useState<PaymentTarget | null>(null);

  const initiate = useMutation<PaymentTarget, Error, { orderId: string; method: PrepaidMethod }>({
    mutationKey: ['payment-initiate'],
    mutationFn: async ({ orderId, method }) =>
      method === 'ESEWA'
        ? esewaTarget(orderId, await initiateEsewa(orderId))
        : khaltiTarget(orderId, await initiateKhalti(orderId)),
    onSuccess: setTarget,
    onError: (error) => {
      if (error instanceof ApiError && error.code === 'RESERVATION_EXPIRED') {
        useCheckoutStore.getState().expireSession();
        return;
      }
      toast(t('paymentFlow.initiateFailed'), 'error');
    },
  });

  const confirm = useMutation<PaymentStatusResponseBody, ApiError, Confirmation>({
    mutationKey: ['payment-confirm'],
    mutationFn: ({ redirect }) =>
      redirect.kind === 'esewa_success' ? confirmEsewa(redirect.data) : lookupKhalti(redirect.pidx),
    onSuccess: ({ payment }) => {
      if (payment === null) {
        // The gateway has not completed the payment (e.g. Khalti "Pending"); the lock still holds.
        toast(t('paymentFlow.notCompleted'), 'info');
        return;
      }
      useCheckoutStore.getState().applyPaymentView(payment);
      toast(t('paymentFlow.success'), 'success');
    },
    onError: (error, { orderId }) => {
      const checkout = useCheckoutStore.getState();
      if (error.code === 'PAID_AFTER_SESSION_EXPIRED') {
        // Money is in escrow but the stock lock had lapsed: the order FAILED and needs a refund.
        checkout.setOrderState(orderId, 'FAILED');
        toast(t('paymentFlow.paidAfterExpiry'), 'error');
      } else if (error.code === 'RESERVATION_EXPIRED') {
        checkout.expireSession();
      } else {
        // Anything else is left to useLockStatus, which keeps polling the order.
        toast(t('paymentFlow.confirmFailed'), 'error');
      }
    },
  });

  const handleRedirect = (
    current: PaymentTarget,
    redirect: Exclude<PaymentRedirect, { kind: 'none' }>,
  ): void => {
    setTarget(null);
    if (
      redirect.kind === 'failure' ||
      (redirect.kind === 'khalti_return' && !khaltiStatusNeedsLookup(redirect.status))
    ) {
      toast(t('paymentFlow.failed'), 'error');
      return;
    }
    confirm.mutate({ orderId: current.orderId, redirect });
  };

  const cancel = (): void => {
    setTarget(null);
    toast(t('paymentFlow.cancelled'), 'info');
  };

  return {
    /** The open payment page, or null when the WebView modal is closed. */
    target,
    start: (orderId: string, method: PrepaidMethod) => {
      initiate.mutate({ orderId, method });
    },
    handleRedirect,
    cancel,
    isStarting: initiate.isPending,
    isConfirming: confirm.isPending,
  };
}
