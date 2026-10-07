import type { VendorOrderView, VendorWalletBalanceResponseBody } from '@hamro-pasal/shared-types';
import { useQueryClient } from '@tanstack/react-query';

import { useVendorBoardStore } from '../../store/useVendorBoardStore';
import { stageOf } from './order-board';
import { vendorOrdersQueryKey } from './useVendorOrders';
import { vendorWalletBalanceQueryKey } from './useVendorWallet';
import {
  mockWalletBalance,
  useVendorFinanceStore,
  VENDOR_FINANCE_MOCKS_ENABLED,
} from './vendor-finance-mocks';
import { VENDOR_ORDER_MOCKS_ENABLED } from './vendor-order-mocks';

export type ShopDeletionBlocker = 'NEGATIVE_BALANCE' | 'ACTIVE_ORDERS';

/** Why a shop account cannot be deleted yet: it owes the platform, or it has orders in hand. */
export function shopDeletionBlockers(state: {
  balanceNpr: number;
  activeOrders: number;
}): ShopDeletionBlocker[] {
  const blockers: ShopDeletionBlocker[] = [];
  if (state.balanceNpr < 0) blockers.push('NEGATIVE_BALANCE');
  if (state.activeOrders > 0) blockers.push('ACTIVE_ORDERS');
  return blockers;
}

/**
 * TEMPORARY: the deletion check from what the phone knows, standing in for
 * `GET /api/vendor/deletion-eligibility` (STATE_HANDOFF.md §8Z.14). The balance is the wallet the
 * app last loaded (else the Ledger's sample figure in a development build); the active orders are
 * the open orders it last loaded, the fleet orders it is still tracking, and the sample orders
 * not yet handed over.
 */
export function useShopDeletionCheck(): () => ShopDeletionBlocker[] {
  const queryClient = useQueryClient();
  return () => {
    const wallet = queryClient.getQueryData<VendorWalletBalanceResponseBody>(
      vendorWalletBalanceQueryKey,
    );
    const model = useVendorFinanceStore.getState().settlementModel;
    const balanceNpr =
      wallet?.wallet_balance_npr ??
      (VENDOR_FINANCE_MOCKS_ENABLED ? mockWalletBalance(model).wallet_balance_npr : 0);

    const live = queryClient.getQueryData<VendorOrderView[]>(vendorOrdersQueryKey) ?? [];
    const { departed, mocks } = useVendorBoardStore.getState();
    const inHand = (order: VendorOrderView, riderPickedUp: boolean): boolean => {
      const stage = stageOf(order, riderPickedUp);
      return stage !== null && stage !== 'HANDED_OVER';
    };
    const activeOrders =
      live.filter((order) => inHand(order, false)).length +
      departed.filter((order) => inHand(order, false)).length +
      (VENDOR_ORDER_MOCKS_ENABLED
        ? mocks.filter((entry) => inHand(entry.order, entry.riderPickedUp === true)).length
        : 0);

    return shopDeletionBlockers({ balanceNpr, activeOrders });
  };
}
