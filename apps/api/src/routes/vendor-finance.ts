import {
  payoutRequestSchema,
  type PayoutRequestResponseBody,
  type PayoutView,
  type VendorFinanceLedgerResponseBody,
} from '@hamro-pasal/shared-types';
import { Router } from 'express';

import type {
  PayoutRow,
  ReconciledOrder,
  VendorFinanceService,
} from '../finance/vendor-finance-service';
import { authOf } from '../http/auth';
import { parseInput } from '../http/validate';

export function payoutView(payout: PayoutRow): PayoutView {
  return {
    id: payout.id,
    amount_npr: payout.amount_npr,
    status: payout.status,
    bank_reference: payout.bank_reference,
    rejection_reason: payout.rejection_reason,
    requested_at: payout.created_at.toISOString(),
    decided_at: payout.decided_at?.toISOString() ?? null,
    transfer_state: payout.transfer_state,
    system_actor: payout.system_actor,
  };
}

function reconciledOrderView(
  order: ReconciledOrder,
): VendorFinanceLedgerResponseBody['reconciled_orders'][number] {
  return {
    order_id: order.orderId,
    payment_method: order.paymentMethod,
    fulfillment: order.fulfillment,
    subtotal_npr: order.subtotalNpr,
    delivery_fee_npr: order.deliveryFeeNpr,
    commission_npr: order.commissionNpr,
    vendor_cut_npr: order.vendorCutNpr,
    wallet_amount_npr: order.walletAmountNpr,
    delivered_at: order.deliveredAt.toISOString(),
    reconciled_at: order.reconciledAt.toISOString(),
  };
}

/**
 * Mounted at /api/vendor/finance behind requireAuth(VENDOR) (Phase 22, SPEC §5): the shop's
 * earnings and its bank withdrawals. Any vendor status may use it: the money is the vendor's.
 */
export function vendorFinanceRouter(finance: VendorFinanceService): Router {
  const router = Router();
  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  router.get('/ledger', async (req, res) => {
    const ledger = await finance.ledgerView(authOf(req).userId);
    const body: VendorFinanceLedgerResponseBody = {
      vendor_id: ledger.vendorId,
      available_balance_npr: ledger.availableBalanceNpr,
      pending_balance_npr: ledger.pendingBalanceNpr,
      pending_payout_npr: ledger.pendingPayoutNpr,
      unreconciled_order_count: ledger.unreconciledOrderCount,
      reconciled_orders: ledger.reconciledOrders.map(reconciledOrderView),
      payouts: ledger.payouts.map(payoutView),
    };
    res.json(body);
  });

  /** The amount leaves the wallet now and waits for a Super Admin's decision. */
  router.post('/payout', async (req, res) => {
    const input = parseInput(payoutRequestSchema, req.body);
    const result = await finance.requestPayout(authOf(req).userId, input);
    const body: PayoutRequestResponseBody = {
      payout: payoutView(result.payout),
      available_balance_npr: result.availableBalanceNpr,
      replayed: result.replayed,
    };
    res.status(result.replayed ? 200 : 201).json(body);
  });

  return router;
}
