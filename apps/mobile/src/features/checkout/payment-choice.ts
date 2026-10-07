import { paymentMethods, type PaymentMethod } from '@hamro-pasal/shared-types';
import { create } from 'zustand';

/** One way to pay, as `POST /api/cart/quote` will list it (`payment_options`, §8Z.5). */
export interface PaymentOption {
  method: PaymentMethod;
  available: boolean;
  /** Why it is not offered ("COD_NOT_AVAILABLE", "SETTLEMENT_MODEL", "PREPAID_BALANCE"). */
  reason?: string;
}

/**
 * TODO: Replace with backend /cart/quote response (`payment_options`).
 * MOCK QUOTE: every method the API accepts today is offered. The real answer will depend on the
 * shop's settlement model and ledger and on the customer's COD eligibility (SPEC "Checkout and
 * Cart Math Protocol": Model A is cash only, and so on), and may list methods this build has
 * never heard of; the Payment Options screen renders whatever list it is given.
 */
export function mockPaymentOptions(): PaymentOption[] {
  return paymentMethods.map((method) => ({ method, available: true }));
}

/**
 * The hand-over between the two checkout steps. The Payment Options screen records the method the
 * customer chose and goes back; the Cart, which owns the checkout (delivery-area check, order,
 * reservation, payment page), takes it from here and starts. Memory only: a choice not picked up
 * is forgotten with the app.
 */
interface PaymentChoiceState {
  chosen: PaymentMethod | null;
  choose: (method: PaymentMethod) => void;
  clear: () => void;
}

export const usePaymentChoiceStore = create<PaymentChoiceState>()((set) => ({
  chosen: null,
  choose: (method) => {
    set({ chosen: method });
  },
  clear: () => {
    set({ chosen: null });
  },
}));
