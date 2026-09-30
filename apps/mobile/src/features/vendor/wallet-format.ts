import type { VendorWalletBalanceResponseBody } from '@hamro-pasal/shared-types';
import type { TFunction } from 'i18next';

import type { AppLocale } from '../../i18n/app-locale';
import { formatLocalizedNumber } from '../../i18n/format-number';

/** "Rs. 950" or "− Rs. 100": a balance, with the sign in front of the currency. */
export function formatBalance(t: TFunction, amountNpr: number): string {
  return amountNpr < 0
    ? t('vendorWallet.negativeAmount', { amount: -amountNpr })
    : t('vendorWallet.amount', { amount: amountNpr });
}

/** "+ Rs. 950" or "− Rs. 100": a posting's effect on the wallet. */
export function formatPosting(t: TFunction, amountNpr: number): string {
  return amountNpr < 0
    ? t('vendorWallet.debit', { amount: -amountNpr })
    : t('vendorWallet.credit', { amount: amountNpr });
}

/** "2026-09-30 16:05" in the device's time zone, Devanagari digits under `ne`. */
export function formatPostedAt(iso: string, locale: AppLocale): string {
  const date = new Date(iso);
  const two = (value: number) => String(value).padStart(2, '0');
  const text = `${String(date.getFullYear())}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}`;
  return text.replace(/\d/g, (digit) => formatLocalizedNumber(Number(digit), locale));
}

/**
 * Why a suspended shop is offline. DEBT: the wallet is below the platform limit (SPEC §5), the
 * banner shows the dues. OTHER: suspended for another reason (an admin decision).
 */
export function suspensionReason(
  balance: VendorWalletBalanceResponseBody,
): 'DEBT' | 'OTHER' | null {
  if (!balance.is_suspended) return null;
  return balance.wallet_balance_npr < balance.suspension_limit_npr ? 'DEBT' : 'OTHER';
}
