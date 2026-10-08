import {
  bankAccountWriteRequestSchema,
  campaignOptInRequestSchema,
  idParamSchema,
  type AuditActor,
  type BankAccountListResponseBody,
  type BankAccountResponseBody,
  type BankAccountView,
  type CampaignOptInResponseBody,
  type CampaignOptInView,
  type VendorCampaignListResponseBody,
  type VendorCampaignView,
} from '@hamro-pasal/shared-types';
import { Router, type Request } from 'express';

import { auditActorOf, auditContextOf } from '../http/request-context';
import { parseInput } from '../http/validate';
import type {
  CampaignOptInRow,
  CampaignService,
  VendorCampaign,
} from '../marketing/campaign-service';
import type {
  BankAccountRow,
  VendorBankAccountService,
} from '../vendor/vendor-bank-account-service';

/** The signed-in vendor as the actor of an audited change (the routers sit behind requireAuth). */
function vendorActor(req: Request): AuditActor & { kind: 'USER' } {
  const actor = auditActorOf(req);
  if (actor.kind !== 'USER') throw new Error('A signed-in caller is always a user');
  return actor;
}

/** The account as its own vendor sees it: the number in full. */
export function bankAccountView(account: BankAccountRow): BankAccountView {
  return {
    id: account.id,
    bank_name: account.bank_name,
    branch_name: account.branch_name,
    account_name: account.account_name,
    account_number: account.account_number,
    routing_or_swift_code: account.routing_or_swift_code,
    is_primary: account.is_primary,
    created_at: account.created_at.toISOString(),
    updated_at: account.updated_at.toISOString(),
  };
}

export function campaignOptInView(optIn: CampaignOptInRow): CampaignOptInView {
  return {
    id: optIn.id,
    campaign_id: optIn.campaign_id,
    vendor_id: optIn.vendor_id,
    opt_in_terms_version: optIn.opt_in_terms_version,
    terms: optIn.terms_snapshot,
    status: optIn.status,
    opted_in_at: optIn.opted_in_at.toISOString(),
  };
}

export function vendorCampaignView({ campaign, latestOptIn }: VendorCampaign): VendorCampaignView {
  return {
    id: campaign.id,
    name: campaign.name,
    kind: campaign.kind,
    value: campaign.value,
    max_discount_npr: campaign.max_discount_npr,
    min_cart_npr: campaign.min_cart_npr,
    vendor_share_percent: campaign.vendor_share_percent,
    terms_version: campaign.terms_version,
    starts_at: campaign.starts_at.toISOString(),
    ends_at: campaign.ends_at.toISOString(),
    opt_in_status: latestOptIn?.status ?? null,
    opt_in_terms_version: latestOptIn?.opt_in_terms_version ?? null,
    opted_in_at: latestOptIn?.status === 'ACTIVE' ? latestOptIn.opted_in_at.toISOString() : null,
  };
}

/**
 * Mounted at /api/vendor/bank-accounts behind requireAuth(VENDOR) (Phase 26). Any vendor status
 * may use it: a shop records where it is paid before it goes live, and while suspended.
 */
export function vendorBankAccountsRouter(bankAccounts: VendorBankAccountService): Router {
  const router = Router();
  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  router.get('/', async (req, res) => {
    const body: BankAccountListResponseBody = {
      bank_accounts: (await bankAccounts.list(vendorActor(req).user_id)).map(bankAccountView),
    };
    res.json(body);
  });

  /** The shop's first account becomes its primary one. */
  router.post('/', async (req, res) => {
    const input = parseInput(bankAccountWriteRequestSchema, req.body);
    const body: BankAccountResponseBody = {
      bank_account: bankAccountView(
        await bankAccounts.create(vendorActor(req), input, auditContextOf(req, res)),
      ),
    };
    res.status(201).json(body);
  });

  /** Replaces every field; `is_primary: true` moves the primary mark to this account. */
  router.put('/:id', async (req, res) => {
    const { id } = parseInput(idParamSchema, { ...req.params });
    const input = parseInput(bankAccountWriteRequestSchema, req.body);
    const body: BankAccountResponseBody = {
      bank_account: bankAccountView(
        await bankAccounts.update(vendorActor(req), id, input, auditContextOf(req, res)),
      ),
    };
    res.json(body);
  });

  return router;
}

/**
 * Mounted at /api/vendor/campaigns behind requireAuth(VENDOR) (Phase 26). The only way a campaign
 * comes to apply to a shop: its own account accepts the terms it was shown.
 */
export function vendorCampaignsRouter(campaigns: CampaignService): Router {
  const router = Router();
  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  /** The invites open to the shop and the campaigns it joined. */
  router.get('/', async (req, res) => {
    const body: VendorCampaignListResponseBody = {
      campaigns: (await campaigns.listForVendor(vendorActor(req).user_id)).map(vendorCampaignView),
    };
    res.json(body);
  });

  /** Stops the campaign applying to the shop's future orders; 200 also on repeat. */
  router.post('/:id/opt-out', async (req, res) => {
    const { id } = parseInput(idParamSchema, { ...req.params });
    const optIn = await campaigns.optOut(vendorActor(req), id, auditContextOf(req, res));
    const body: CampaignOptInResponseBody = { opt_in: campaignOptInView(optIn) };
    res.json(body);
  });

  router.post('/:id/opt-in', async (req, res) => {
    const { id } = parseInput(idParamSchema, { ...req.params });
    const input = parseInput(campaignOptInRequestSchema, req.body);
    const result = await campaigns.optIn(
      vendorActor(req),
      id,
      input.terms_version,
      auditContextOf(req, res),
    );
    const body: CampaignOptInResponseBody = { opt_in: campaignOptInView(result.optIn) };
    res.status(result.created ? 201 : 200).json(body);
  });

  return router;
}
