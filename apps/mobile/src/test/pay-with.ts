import type { PaymentMethod } from '@hamro-pasal/shared-types';
import { act } from '@testing-library/react-native';

import { usePaymentChoiceStore } from '../features/checkout/payment-choice';

/**
 * What the Payment Options screen does when the customer confirms a method: it hands the choice
 * to the mounted Cart, which checks it may proceed and starts the checkout. Tests of the cart use
 * this instead of rendering the second screen (which has its own tests).
 */
export function payWith(method: PaymentMethod): void {
  act(() => {
    usePaymentChoiceStore.getState().choose(method);
  });
}
