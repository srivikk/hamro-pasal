import {
  vendorWalletLedgerQuerySchema,
  walletTopUpRequestSchema,
  type WalletTopUpResponseBody,
  type VendorWalletBalanceResponseBody,
  type VendorWalletLedgerResponseBody,
} from '@hamro-pasal/shared-types';
import { Router } from 'express';

import { authOf } from '../http/auth';
import { parseInput } from '../http/validate';
import type { VendorTopUpService } from '../wallet/vendor-top-up-service';
import type {
  VendorWalletBalance,
  VendorWalletEntry,
  VendorWalletService,
} from '../wallet/vendor-wallet-service';

function balanceBody(balance: VendorWalletBalance): VendorWalletBalanceResponseBody {
  return {
    vendor_id: balance.vendorId,
    status: balance.status,
    is_suspended: balance.status === 'SUSPENDED',
    suspended_for_debt: balance.suspendedForDebt,
    wallet_balance_npr: balance.walletBalanceNpr,
    suspension_limit_npr: balance.suspensionLimitNpr,
    pending_escrow_npr: balance.pendingEscrowNpr,
    pending_escrow_order_count: balance.pendingEscrowOrderCount,
    dispute_hold_npr: balance.disputeHoldNpr,
    dispute_hold_order_count: balance.disputeHoldOrderCount,
  };
}

function entryView(entry: VendorWalletEntry): VendorWalletLedgerResponseBody['entries'][number] {
  return {
    id: entry.id,
    transaction_id: entry.transactionId,
    kind: entry.kind,
    entry_type: entry.entryType,
    amount_npr: entry.amountNpr,
    balance_after_npr: entry.balanceAfterNpr,
    description: entry.description,
    created_at: entry.createdAt.toISOString(),
    order:
      entry.order === null
        ? null
        : {
            id: entry.order.id,
            payment_method: entry.order.paymentMethod,
            fulfillment: entry.order.fulfillment,
            subtotal_npr: entry.order.subtotalNpr,
            delivery_fee_npr: entry.order.deliveryFeeNpr,
            commission_npr: entry.order.commissionNpr,
          },
  };
}

/**
 * Mounted at /api/vendors/wallet behind requireAuth(VENDOR) (SPEC §5). A SUSPENDED vendor can use
 * every route: they need them to see and pay what they owe.
 */
export function vendorWalletRouter(
  wallet: VendorWalletService,
  topUps: VendorTopUpService,
): Router {
  const router = Router();

  router.get('/balance', async (req, res) => {
    const body = balanceBody(await wallet.balance(authOf(req).userId));
    res.setHeader('Cache-Control', 'no-store');
    res.json(body);
  });

  router.get('/ledger', async (req, res) => {
    const query = parseInput(vendorWalletLedgerQuerySchema, { ...req.query });
    const page = await wallet.ledger(authOf(req).userId, query);
    const body: VendorWalletLedgerResponseBody = {
      entries: page.entries.map(entryView),
      next_cursor: page.nextCursor,
    };
    res.setHeader('Cache-Control', 'no-store');
    res.json(body);
  });

  /**
   * SPEC §5: the vendor pays upfront to clear a negative wallet. MOCK mode credits without a payment
   * (dev only); DISABLED answers 503 TOP_UP_UNAVAILABLE. Clearing the debt lifts a debt suspension.
   */
  router.post('/top-up', async (req, res) => {
    const input = parseInput(walletTopUpRequestSchema, req.body);
    const result = await topUps.topUp(authOf(req).userId, input);
    const body: WalletTopUpResponseBody = {
      transaction_id: result.transactionId,
      amount_npr: result.amountNpr,
      wallet_balance_npr: result.walletBalanceNpr,
      status: result.status,
      is_suspended: result.status === 'SUSPENDED',
      restored: result.restored,
      replayed: result.replayed,
    };
    res.setHeader('Cache-Control', 'no-store');
    res.status(result.replayed ? 200 : 201).json(body);
  });

  return router;
}
