import {
  vendorWalletLedgerQuerySchema,
  type VendorWalletBalanceResponseBody,
  type VendorWalletLedgerResponseBody,
} from '@hamro-pasal/shared-types';
import { Router } from 'express';

import { authOf } from '../http/auth';
import { parseInput } from '../http/validate';
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
    wallet_balance_npr: balance.walletBalanceNpr,
    suspension_limit_npr: balance.suspensionLimitNpr,
    pending_escrow_npr: balance.pendingEscrowNpr,
    pending_escrow_order_count: balance.pendingEscrowOrderCount,
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
 * Mounted at /api/vendors/wallet behind requireAuth(VENDOR) (SPEC §5). A SUSPENDED vendor can read
 * both: they need them to see what they owe.
 */
export function vendorWalletRouter(wallet: VendorWalletService): Router {
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

  return router;
}
