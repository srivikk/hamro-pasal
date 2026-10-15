import type { VendorWalletBalanceResponseBody } from '@hamro-pasal/shared-types';
import { create } from 'zustand';

/** SPEC's settlement models A, B and C. Every vendor is B until the others are built (§8Z.5). */
export const SETTLEMENT_MODELS = ['COD_CREDIT', 'PLATFORM_ESCROW', 'DIRECT_PREPAID'] as const;
export type SettlementModel = (typeof SETTLEMENT_MODELS)[number];

/** Model C's Fixed Reserve: the minimum and the default (SPEC Financial Governance). */
export const PREPAID_RESERVE_NPR = 5000;

/**
 * TEMPORARY: sample figures on the Ledger tab, so the three settlement-model layouts can be seen
 * before the server knows any model but B. Development builds only, and off with
 * `EXPO_PUBLIC_MOCK_VENDOR_FINANCE=false` in `apps/mobile/.env`.
 */
export const VENDOR_FINANCE_MOCKS_ENABLED =
  __DEV__ && process.env.EXPO_PUBLIC_MOCK_VENDOR_FINANCE !== 'false';

const MOCK_VENDOR_ID = '00000000-0000-4000-8000-00000000aaaa';

const sample = (
  wallet: number,
  escrow: number,
  escrowOrders: number,
): VendorWalletBalanceResponseBody => ({
  vendor_id: MOCK_VENDOR_ID,
  status: 'LIVE',
  is_suspended: false,
  suspended_for_debt: false,
  wallet_balance_npr: wallet,
  suspension_limit_npr: -2000,
  pending_escrow_npr: escrow,
  pending_escrow_order_count: escrowOrders,
  dispute_hold_npr: 0,
  dispute_hold_order_count: 0,
});

/** What each model's card shows when there is no real figure for it. */
export function mockWalletBalance(model: SettlementModel): VendorWalletBalanceResponseBody {
  switch (model) {
    case 'COD_CREDIT':
      return sample(-1200, 0, 0); // 60% of the credit limit used
    case 'PLATFORM_ESCROW':
      return sample(8450, 3200, 4);
    case 'DIRECT_PREPAID':
      return sample(7500, 0, 0); // Rs. 2,500 above the reserve
  }
}

/**
 * How much of the credit limit a balance has used, 0 to 1: 0 while the balance is 0 or above, 1 at
 * the limit or beyond it (the shop is suspended strictly below the limit).
 */
export function creditUsedFraction(balanceNpr: number, limitNpr: number): number {
  if (balanceNpr >= 0 || limitNpr >= 0) return 0;
  return Math.min(1, balanceNpr / limitNpr);
}

interface VendorFinanceState {
  /**
   * The settlement model whose layout the Ledger shows. The server does not send one yet
   * (`vendors.settlement_model` is unbuilt), so this is PLATFORM_ESCROW, which is what every shop
   * runs on today; a development build can switch it to preview the other two.
   */
  settlementModel: SettlementModel;
  setSettlementModel: (model: SettlementModel) => void;
}

export const useVendorFinanceStore = create<VendorFinanceState>()((set) => ({
  settlementModel: 'PLATFORM_ESCROW',
  setSettlementModel: (settlementModel) => {
    set({ settlementModel });
  },
}));
