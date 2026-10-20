import {
  paymentMethodUnavailableDetailsSchema,
  quoteChangedDetailsSchema,
  type PaymentMethod,
} from '@hamro-pasal/shared-types';
import type { TFunction } from 'i18next';
import type { AlertButton } from 'react-native';
import { z } from 'zod';

import type { ApiError } from '../../api/http';

/** Checkout refusals the cart answers with a dialog instead of a line of text. */
export const CHECKOUT_DIALOG_CODES = {
  /** 409: an offer or campaign ended since the customer saw the total. */
  quoteChanged: 'QUOTE_CHANGED',
  /** 422: the shop does not take the chosen payment method (any more). */
  paymentMethodUnavailable: 'PAYMENT_METHOD_UNAVAILABLE',
} as const;

const categoryRefusalSchema = z.object({ product_names: z.array(z.string().min(1)).min(1) });

/**
 * 422 CATEGORY_UNAVAILABLE (decided 2026-10-20): the Super Admin hid the category of an item, or a
 * category above it, after it went into the cart. The first such item, to name in the message.
 */
export function hiddenCategoryItem(details: unknown): string | null {
  const parsed = categoryRefusalSchema.safeParse(details);
  return parsed.success ? (parsed.data.product_names[0] ?? null) : null;
}

export function isDialogRefusal(code: string): boolean {
  return (Object.values(CHECKOUT_DIALOG_CODES) as string[]).includes(code);
}

export interface RefusalDialog {
  title: string;
  message: string;
  buttons: AlertButton[];
}

export interface RefusalActions {
  /** Place the same order at the total the server now quotes. */
  acceptTotal: (totalNpr: number) => void;
  /** Back to the Payment Options screen. */
  chooseAnotherMethod: () => void;
}

/**
 * What to tell the customer, and what they can do about it, when checkout answers
 * 409 QUOTE_CHANGED or 422 PAYMENT_METHOD_UNAVAILABLE. Null for every other refusal.
 *
 * - QUOTE_CHANGED with the new quote: both totals are shown and the customer may accept the new
 *   one (the order is then sent with it) or go back to the cart. Without it (the offer ended in
 *   the instant between pricing and the order) the cart simply shows the refreshed bill.
 * - PAYMENT_METHOD_UNAVAILABLE: names what the shop does accept and offers the way back to the
 *   payment step; when the shop accepts nothing there is only "OK".
 */
export function checkoutRefusalDialog(
  t: TFunction,
  error: ApiError,
  attempt: { paymentMethod: PaymentMethod; expectedTotalNpr: number | null },
  actions: RefusalActions,
): RefusalDialog | null {
  if (error.code === CHECKOUT_DIALOG_CODES.quoteChanged) {
    const details = quoteChangedDetailsSchema.safeParse(error.details);
    if (!details.success) {
      return {
        title: t('checkout.quoteChanged.title'),
        message: t('checkout.quoteChanged.bodyUnknown'),
        buttons: [{ text: t('checkout.quoteChanged.review') }],
      };
    }
    const now = details.data.quote.total_npr;
    return {
      title: t('checkout.quoteChanged.title'),
      message:
        attempt.expectedTotalNpr === null
          ? t('checkout.quoteChanged.bodyNow', { now })
          : t('checkout.quoteChanged.body', { was: attempt.expectedTotalNpr, now }),
      buttons: [
        { text: t('checkout.quoteChanged.review'), style: 'cancel' },
        {
          text: t('checkout.quoteChanged.accept', { amount: now }),
          onPress: () => {
            actions.acceptTotal(now);
          },
        },
      ],
    };
  }

  if (error.code === CHECKOUT_DIALOG_CODES.paymentMethodUnavailable) {
    const details = paymentMethodUnavailableDetailsSchema.safeParse(error.details);
    const accepted = details.success ? details.data.accepted : [];
    const method = t(`payment.${attempt.paymentMethod}`);
    if (accepted.length === 0) {
      return {
        title: t('checkout.methodUnavailable.title'),
        message: t('checkout.methodUnavailable.none', { method }),
        buttons: [{ text: t('checkout.methodUnavailable.ok') }],
      };
    }
    const methods = accepted.map((each) => t(`payment.${each}`)).join(', ');
    return {
      title: t('checkout.methodUnavailable.title'),
      message:
        details.success && details.data.reason === 'SETTLEMENT_MODEL'
          ? t('checkout.methodUnavailable.cashOnly', { method, methods })
          : t('checkout.methodUnavailable.body', { method, methods }),
      buttons: [
        { text: t('checkout.methodUnavailable.cancel'), style: 'cancel' },
        { text: t('checkout.methodUnavailable.choose'), onPress: actions.chooseAnotherMethod },
      ],
    };
  }
  return null;
}
