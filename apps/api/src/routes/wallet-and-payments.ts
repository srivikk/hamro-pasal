import {
  adminPlanAssignRequestSchema,
  gatewayAccountWriteRequestSchema,
  gatewayPaymentMethodSchema,
  idParamSchema,
  walletRechargeConfirmRequestSchema,
  walletRechargeRequestSchema,
  type AdminPlanAssignResponseBody,
  type AuditActor,
  type CustomerWalletView,
  type GatewayAccountListResponseBody,
  type GatewayAccountResponseBody,
  type VendorBillingView,
  type WalletRechargeConfirmResponseBody,
  type WalletRechargeInitiateResponseBody,
} from '@hamro-pasal/shared-types';
import { Router, type Request } from 'express';
import { z } from 'zod';

import { authOf } from '../http/auth';
import { auditActorOf, auditContextOf } from '../http/request-context';
import { parseInput } from '../http/validate';
import type { VendorGatewayAccountService } from '../payments/gateway-accounts';
import type { VendorBillingService } from '../vendor/vendor-billing-service';
import type { CustomerWalletService, RechargeTarget } from '../wallet/customer-wallet-service';

/*
 * 2026-10-21 (SPEC core 4, 5, 9 and 12): the customer's stored-value wallet, a Model C shop's own
 * merchant accounts and its billing view, and the Super Admin's plan assignment and merchant
 * account check.
 */

const gatewayParamSchema = z.strictObject({ gateway: gatewayPaymentMethodSchema });

function userActor(req: Request): AuditActor & { kind: 'USER' } {
  const actor = auditActorOf(req);
  if (actor.kind !== 'USER') throw new Error('A signed-in caller is always a user');
  return actor;
}

function noStore(router: Router): Router {
  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  return router;
}

/**
 * Mounted at /api/wallet behind requireAuth(CUSTOMER) (the customer's own wallet), and at
 * /api/vendors/wallet behind requireAuth(VENDOR) for a shop's ledger recharge (`owner` VENDOR:
 * no GET there; the shop's wallet has its own reads).
 */
export function walletRechargeRouter(
  wallet: CustomerWalletService,
  owner: RechargeTarget['kind'],
): Router {
  const router = noStore(Router());
  const targetOf = (req: Request): RechargeTarget => ({ kind: owner, userId: authOf(req).userId });

  if (owner === 'CUSTOMER') {
    router.get('/', async (req, res) => {
      const body: CustomerWalletView = await wallet.view(authOf(req).userId);
      res.json(body);
    });
  }

  /** 201 for a new recharge, 200 for a replayed key: the signed eSewa form either way. */
  router.post('/recharge/esewa/initiate', async (req, res) => {
    const input = parseInput(walletRechargeRequestSchema, req.body);
    const started = await wallet.initiateEsewa(targetOf(req), input);
    const body: WalletRechargeInitiateResponseBody = {
      recharge: started.recharge,
      payment_url: started.paymentUrl,
      method: 'POST',
      fields: started.fields,
    };
    res.status(started.replayed ? 200 : 201).json(body);
  });

  router.post('/recharge/esewa/confirm', async (req, res) => {
    const { data } = parseInput(walletRechargeConfirmRequestSchema, req.body);
    const outcome = await wallet.confirmEsewa(targetOf(req), data);
    const body: WalletRechargeConfirmResponseBody = {
      status: outcome.status,
      recharge: outcome.recharge,
      balance_npr: outcome.balanceNpr,
      credited: outcome.credited,
    };
    res.json(body);
  });

  return router;
}

/** Mounted at /api/vendor behind requireAuth(VENDOR), before the settings router. */
export function vendorPaymentsRouter(
  billing: VendorBillingService,
  gatewayAccounts: VendorGatewayAccountService,
): Router {
  const router = noStore(Router());

  router.get('/billing', async (req, res) => {
    const body: VendorBillingView = await billing.view(authOf(req).userId);
    res.json(body);
  });

  router.get('/gateway-accounts', async (req, res) => {
    const body: GatewayAccountListResponseBody = {
      accounts: await gatewayAccounts.list(authOf(req).userId),
    };
    res.json(body);
  });

  router.put('/gateway-accounts/:gateway', async (req, res) => {
    const { gateway } = parseInput(gatewayParamSchema, { ...req.params });
    const input = parseInput(gatewayAccountWriteRequestSchema, req.body);
    const body: GatewayAccountResponseBody = {
      account: await gatewayAccounts.save(userActor(req), gateway, input, auditContextOf(req, res)),
    };
    res.json(body);
  });

  return router;
}

/** Mounted at /api/admin behind requireAuth(SUPER_ADMIN), before the main admin router. */
export function adminPaymentsRouter(
  billing: VendorBillingService,
  gatewayAccounts: VendorGatewayAccountService,
): Router {
  const router = noStore(Router());

  router.put('/vendors/:id/pricing-plan', async (req, res) => {
    const { id } = parseInput(idParamSchema, { ...req.params });
    const { pricing_plan_id } = parseInput(adminPlanAssignRequestSchema, req.body);
    const body: AdminPlanAssignResponseBody = await billing.assignPlan(
      authOf(req).userId,
      id,
      pricing_plan_id,
      auditContextOf(req, res),
    );
    res.json(body);
  });

  router.post('/vendors/:id/gateway-accounts/:gateway/verify', async (req, res) => {
    const { id } = parseInput(idParamSchema, { id: req.params.id });
    const { gateway } = parseInput(gatewayParamSchema, { gateway: req.params.gateway });
    const body: GatewayAccountResponseBody = {
      account: await gatewayAccounts.verify(
        authOf(req).userId,
        id,
        gateway,
        auditContextOf(req, res),
      ),
    };
    res.json(body);
  });

  return router;
}
