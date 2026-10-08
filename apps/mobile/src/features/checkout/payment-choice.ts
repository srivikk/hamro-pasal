import type { CartQuoteResponseBody, PaymentMethod } from '@hamro-pasal/shared-types';
import { create } from 'zustand';

/** One way to pay, as `POST /api/cart/quote` lists it (`payment_options`). */
export type PaymentOption = CartQuoteResponseBody['payment_options'][number];

/** What the customer confirmed on the Payment Options screen. */
export interface PaymentChoice {
  method: PaymentMethod;
  /**
   * The total the customer saw and agreed to pay. Sent with checkout, which refuses the order
   * (409 QUOTE_CHANGED) if the server's total has moved since. Null: no total was shown.
   */
  expectedTotalNpr: number | null;
}

/**
 * The hand-over between the two checkout steps. The Payment Options screen records the method the
 * customer chose and goes back; the Cart, which owns the checkout (delivery-area check, order,
 * reservation, payment page), takes it from here and starts. Memory only: a choice not picked up
 * is forgotten with the app.
 */
interface PaymentChoiceState {
  chosen: PaymentChoice | null;
  choose: (method: PaymentMethod, expectedTotalNpr?: number | null) => void;
  clear: () => void;
}

export const usePaymentChoiceStore = create<PaymentChoiceState>()((set) => ({
  chosen: null,
  choose: (method, expectedTotalNpr = null) => {
    set({ chosen: { method, expectedTotalNpr } });
  },
  clear: () => {
    set({ chosen: null });
  },
}));
