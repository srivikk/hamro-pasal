import { createAdminApi } from '../api/admin-api';
import { ApiError, createApiClient, type FetchLike } from '../api/client';
import { createSessionStore } from '../auth/session-store';
import { tabFromHash } from '../tabs';
import {
  defaultToggle,
  emptyPlanForm,
  formFromPlan,
  offeredToggle,
  planRows,
  planSaveError,
  planTermsLabel,
  pricingPlanCreateRequestSchema,
  pricingPlanUpdateRequestSchema,
  pricingPlanViewSchema,
  validateNewPlan,
  validatePlanEdit,
  withModel,
  type PlanFormValues,
  type PricingPlanView,
} from './pricing/pricing-rules';
import {
  BANK_ACCOUNT_MISSING_MESSAGE,
  PAN_NOT_VERIFIED_MESSAGE,
  payableVendors,
  payoutButton,
  payoutFormFor,
  payoutSaveError,
  replaceSettlementVendor,
  settlementPayoutRequestSchema,
  settlementTotals,
  settlementVendorViewSchema,
  validatePayoutForm,
  type SettlementVendorView,
} from './settlements/settlement-rules';

const basic: PricingPlanView = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Basic Commission',
  model: 'COMMISSION',
  commission_rate: 10,
  monthly_fee_npr: 0,
  duration_cycles: null,
  is_offered: true,
  is_default: true,
  vendor_count: 6,
  created_at: '2026-08-01T06:00:00.000Z',
};

const premium: PricingPlanView = {
  ...basic,
  id: '22222222-2222-4222-8222-222222222222',
  name: 'Premium Commission',
  commission_rate: 8,
  is_default: false,
  vendor_count: 0,
};

const gold: PricingPlanView = {
  ...basic,
  id: '33333333-3333-4333-8333-333333333333',
  name: 'Gold Subscription',
  model: 'SUBSCRIPTION',
  commission_rate: 0,
  monthly_fee_npr: 1500,
  is_default: false,
  vendor_count: 1,
};

const trial: PricingPlanView = {
  ...basic,
  id: '44444444-4444-4444-8444-444444444444',
  name: 'Dashain Free Trial',
  model: 'FREE',
  commission_rate: 0,
  duration_cycles: 3,
  is_default: false,
  vendor_count: 1,
};

const plans = [basic, premium, gold, trial];
const STAMP = { id: '55555555-5555-4555-8555-555555555555', now: '2026-10-07T06:00:00.000Z' };

const newPlan: PlanFormValues = {
  name: '  Silver Commission ',
  model: 'COMMISSION',
  terms: '7.5',
  isOffered: true,
  isDefault: false,
};

const KEY = '0b0e7c1e-5a55-4e0b-9c64-3d2f0f6f7a11';

interface Call {
  readonly call: string;
  readonly body: unknown;
}

/** The admin API over a fake fetch that answers each call with `respond`. */
function setup(respond: (call: string) => { status?: number; body: unknown }) {
  const calls: Call[] = [];
  const fetch: FetchLike = (url, init) => {
    const call = `${init.method ?? ''} ${url}`;
    calls.push({
      call,
      body: typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : init.body,
    });
    const { status = 200, body } = respond(call);
    return Promise.resolve(new Response(JSON.stringify(body), { status }));
  };
  const session = createSessionStore();
  session.getState().setSession({
    phone: '+9779800000099',
    user: { id: STAMP.id, role: 'SUPER_ADMIN', first_name: null },
    accessToken: 'access-1',
  });
  return { calls, api: createAdminApi(createApiClient({ baseUrl: '', fetch, session })) };
}

const refusal = (status: number, code: string, details?: unknown) => ({
  status,
  body: { error: { code, message: code, ...(details === undefined ? {} : { details }) } },
});

const ready: SettlementVendorView = {
  vendor_id: '66666666-6666-4666-8666-666666666666',
  business_name: 'Thamel Kirana Pasal',
  phone: '+9779800000011',
  settlement_model: 'PLATFORM_ESCROW',
  available_for_payout_npr: 8450,
  pending_escrow_npr: 3200,
  tax_id: '302118845',
  pan_verified_at: '2026-09-28T07:30:00.000Z',
  primary_bank_account: {
    id: 'b0000000-0000-4000-8000-000000000001',
    bank_name: 'Nabil Bank',
    branch_name: 'Thamel',
    account_name: 'Sample Traders',
    account_number: '0123456789012',
    routing_or_swift_code: null,
  },
};

const held: SettlementVendorView = {
  ...ready,
  vendor_id: '77777777-7777-4777-8777-777777777777',
  business_name: 'New Road Electronics',
  available_for_payout_npr: 15400,
  tax_id: '609871234',
  pan_verified_at: null,
  primary_bank_account: {
    id: 'b0000000-0000-4000-8000-000000000001',
    bank_name: 'Nabil Bank',
    branch_name: 'Thamel',
    account_name: 'Sample Traders',
    account_number: '0123456789012',
    routing_or_swift_code: null,
  },
};

/** Verified, with money waiting, but nowhere to send it. */
const noBank: SettlementVendorView = {
  ...ready,
  vendor_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  business_name: 'Asan Masala & Snacks',
  available_for_payout_npr: 2000,
  primary_bank_account: null,
};

describe('tabs', () => {
  it('opens the two sections by their hash', () => {
    expect(tabFromHash('#/pricing-plans')).toBe('pricing-plans');
    expect(tabFromHash('#/settlements')).toBe('settlements');
  });
});

describe('pricing plan contract', () => {
  it('accepts a plan of every model', () => {
    for (const plan of plans) expect(pricingPlanViewSchema.safeParse(plan).success).toBe(true);
  });

  const request = {
    name: 'Silver Commission',
    model: 'COMMISSION',
    commission_rate: 7.5,
    monthly_fee_npr: 0,
    duration_cycles: null,
    is_offered: true,
    is_default: false,
  } as const;
  const accepts = (body: unknown) => pricingPlanCreateRequestSchema.safeParse(body).success;

  it('gives each model its own terms and no other', () => {
    expect(accepts(request)).toBe(true);
    expect(accepts({ ...request, commission_rate: 0 })).toBe(false);
    expect(accepts({ ...request, commission_rate: 100.01 })).toBe(false);
    expect(accepts({ ...request, monthly_fee_npr: 500 })).toBe(false);
    expect(accepts({ ...request, duration_cycles: 3 })).toBe(false);

    const subscription = { ...request, model: 'SUBSCRIPTION', commission_rate: 0 };
    expect(accepts({ ...subscription, monthly_fee_npr: 1500 })).toBe(true);
    expect(accepts(subscription)).toBe(false);
    expect(accepts({ ...subscription, monthly_fee_npr: 1500, commission_rate: 5 })).toBe(false);

    const free = { ...request, model: 'FREE', commission_rate: 0 };
    expect(accepts({ ...free, duration_cycles: 3 })).toBe(true);
    expect(accepts(free)).toBe(false);
    expect(accepts({ ...free, duration_cycles: 2.5 })).toBe(false);
    expect(accepts({ ...free, duration_cycles: 0 })).toBe(false);
  });

  it('lets only an offered Commission plan be the default', () => {
    expect(accepts({ ...request, is_default: true })).toBe(true);
    expect(accepts({ ...request, is_default: true, is_offered: false })).toBe(false);
    expect(
      accepts({
        ...request,
        model: 'SUBSCRIPTION',
        commission_rate: 0,
        monthly_fee_npr: 1500,
        is_default: true,
      }),
    ).toBe(false);
    expect(
      accepts({
        ...request,
        model: 'FREE',
        commission_rate: 0,
        duration_cycles: 3,
        is_default: true,
      }),
    ).toBe(false);
  });

  it('has no way to change the model or terms of an existing plan', () => {
    const update = { name: 'Basic Commission', is_offered: true, is_default: true };
    expect(pricingPlanUpdateRequestSchema.safeParse(update).success).toBe(true);
    for (const extra of [
      { commission_rate: 5 },
      { monthly_fee_npr: 100 },
      { duration_cycles: 1 },
      { model: 'FREE' },
    ]) {
      expect(pricingPlanUpdateRequestSchema.safeParse({ ...update, ...extra }).success).toBe(false);
    }
    // The default plan stays on offer.
    expect(pricingPlanUpdateRequestSchema.safeParse({ ...update, is_offered: false }).success).toBe(
      false,
    );
  });
});

describe('pricing plan form', () => {
  it('starts as an offered Commission plan that is not the default', () => {
    expect(emptyPlanForm()).toEqual({
      name: '',
      model: 'COMMISSION',
      terms: '',
      isOffered: true,
      isDefault: false,
    });
  });

  it('builds the request for each model from the one terms field', () => {
    expect(validateNewPlan(newPlan, plans)).toEqual({
      ok: true,
      request: {
        name: 'Silver Commission',
        model: 'COMMISSION',
        commission_rate: 7.5,
        monthly_fee_npr: 0,
        duration_cycles: null,
        is_offered: true,
        is_default: false,
      },
    });
    expect(
      validateNewPlan(
        { ...newPlan, name: 'Platinum', model: 'SUBSCRIPTION', terms: '2500' },
        plans,
      ),
    ).toMatchObject({
      ok: true,
      request: { commission_rate: 0, monthly_fee_npr: 2500, duration_cycles: null },
    });
    expect(
      validateNewPlan({ ...newPlan, name: 'Tihar Trial', model: 'FREE', terms: '2' }, plans),
    ).toMatchObject({
      ok: true,
      request: { commission_rate: 0, monthly_fee_npr: 0, duration_cycles: 2 },
    });
  });

  it('words the terms error by the model', () => {
    expect(validateNewPlan({ ...newPlan, terms: '0' }, plans)).toEqual({
      ok: false,
      errors: { terms: 'Enter a percentage above 0, up to 100.' },
    });
    expect(validateNewPlan({ ...newPlan, terms: '101' }, plans).ok).toBe(false);
    expect(validateNewPlan({ ...newPlan, terms: '7.555' }, plans).ok).toBe(false);
    expect(validateNewPlan({ ...newPlan, model: 'SUBSCRIPTION', terms: '' }, plans)).toEqual({
      ok: false,
      errors: { terms: 'Enter a monthly fee above 0.' },
    });
    expect(validateNewPlan({ ...newPlan, model: 'FREE', terms: '1.5' }, plans)).toEqual({
      ok: false,
      errors: { terms: 'Enter a whole number of Billing Cycles, from 1 to 36.' },
    });
  });

  it('refuses a blank name and one another plan has, in any letter case', () => {
    expect(validateNewPlan({ ...newPlan, name: '  ' }, plans)).toEqual({
      ok: false,
      errors: { name: 'Enter a name of at most 80 characters.' },
    });
    expect(validateNewPlan({ ...newPlan, name: 'gold subscription' }, plans)).toEqual({
      ok: false,
      errors: { name: 'Another plan already has this name.' },
    });
    // Keeping its own name is not a clash.
    expect(validatePlanEdit(formFromPlan(gold), gold, plans).ok).toBe(true);
    expect(
      validatePlanEdit({ ...formFromPlan(gold), name: 'BASIC COMMISSION' }, gold, plans),
    ).toEqual({ ok: false, errors: { name: 'Another plan already has this name.' } });
  });

  it('refuses a default that is not an offered Commission plan', () => {
    expect(
      validateNewPlan({ ...newPlan, model: 'SUBSCRIPTION', terms: '1500', isDefault: true }, plans),
    ).toEqual({
      ok: false,
      errors: { isDefault: 'Only a Commission plan that is on offer can be the default.' },
    });
    expect(validateNewPlan({ ...newPlan, isOffered: false, isDefault: true }, plans).ok).toBe(
      false,
    );
  });

  it('empties the terms and drops the default when the model changes', () => {
    const typed = { ...newPlan, isDefault: true };
    expect(withModel(typed, 'SUBSCRIPTION')).toEqual({
      ...typed,
      model: 'SUBSCRIPTION',
      terms: '',
      isDefault: false,
    });
    expect(withModel(typed, 'COMMISSION')).toBe(typed);
  });

  it('sends only the name and the two toggles for an edit, whatever the form holds', () => {
    const tampered = { ...formFromPlan(premium), name: 'Premium 8%', terms: '1', isDefault: true };
    expect(validatePlanEdit(tampered, premium, plans)).toEqual({
      ok: true,
      request: { name: 'Premium 8%', is_offered: true, is_default: true },
    });
  });

  it('refuses to make a Subscription or Free plan the default by an edit', () => {
    for (const plan of [gold, trial]) {
      expect(validatePlanEdit({ ...formFromPlan(plan), isDefault: true }, plan, plans)).toEqual({
        ok: false,
        errors: { isDefault: 'Only a Commission plan can be the default.' },
      });
    }
  });

  it('refuses to switch the default off or withdraw it', () => {
    expect(validatePlanEdit({ ...formFromPlan(basic), isDefault: false }, basic, plans)).toEqual({
      ok: false,
      errors: { isDefault: 'Make another Commission plan the default instead.' },
    });
    expect(validatePlanEdit({ ...formFromPlan(basic), isOffered: false }, basic, plans)).toEqual({
      ok: false,
      errors: { isOffered: 'The default plan must stay on offer.' },
    });
  });
});

describe('the default plan toggle', () => {
  it('is locked on the current default', () => {
    expect(defaultToggle(formFromPlan(basic), basic, plans)).toEqual({
      enabled: false,
      note: 'This is the default plan. To change it, make another Commission plan the default.',
    });
    expect(offeredToggle(basic)).toEqual({
      enabled: false,
      note: 'The default plan cannot be withdrawn.',
    });
  });

  it('is locked for a Subscription, a Free and a withdrawn plan', () => {
    expect(defaultToggle({ model: 'SUBSCRIPTION', isOffered: true }, null, plans).enabled).toBe(
      false,
    );
    expect(defaultToggle({ model: 'FREE', isOffered: true }, null, plans).enabled).toBe(false);
    expect(defaultToggle({ model: 'COMMISSION', isOffered: false }, premium, plans)).toEqual({
      enabled: false,
      note: 'A withdrawn plan cannot be the default.',
    });
  });

  it('names the plan it would replace', () => {
    expect(defaultToggle({ model: 'COMMISSION', isOffered: true }, premium, plans)).toEqual({
      enabled: true,
      note: 'Replaces “Basic Commission” as the default.',
    });
    expect(defaultToggle({ model: 'COMMISSION', isOffered: true }, null, []).note).toBe(
      'Vendors whose Free plan expires move to the default plan.',
    );
  });

  it('says who keeps a plan that is withdrawn', () => {
    expect(offeredToggle(gold).note).toBe(
      'Withdrawing stops new selections. The 1 vendor on it keeps it.',
    );
    expect(offeredToggle({ ...gold, vendor_count: 4 }).note).toBe(
      'Withdrawing stops new selections. The 4 vendors on it keep it.',
    );
    expect(offeredToggle(premium)).toEqual({ enabled: true, note: null });
    expect(offeredToggle(null)).toEqual({ enabled: true, note: null });
  });
});

describe('pricing plan rows', () => {
  it('lists Commission first with the default on top, then Subscription, then Free', () => {
    expect(planRows([trial, gold, premium, basic]).map((plan) => plan.id)).toEqual([
      basic.id,
      premium.id,
      gold.id,
      trial.id,
    ]);
  });

  it('words the terms of each model', () => {
    expect(planTermsLabel(basic)).toBe('10% commission per order');
    expect(planTermsLabel(gold)).toBe('Rs. 1,500 per month, 0% commission');
    expect(planTermsLabel(trial)).toBe('Free for 3 Billing Cycles, then the default plan');
    expect(planTermsLabel({ ...trial, duration_cycles: 1 })).toBe(
      'Free for 1 Billing Cycle, then the default plan',
    );
  });
});

describe('createAdminApi (pricing plan endpoints)', () => {
  const created = { ...premium, id: STAMP.id, name: 'Silver Commission', commission_rate: 7.5 };

  it('lists, creates and edits plans under /api/admin/pricing-plans', async () => {
    const { calls, api } = setup((call) =>
      call.startsWith('GET') ? { body: { plans } } : { body: { plan: created } },
    );
    const create = validateNewPlan(newPlan, plans);
    const edit = validatePlanEdit({ ...formFromPlan(premium), isDefault: true }, premium, plans);
    if (!create.ok || !edit.ok) throw new Error('form refused');

    await expect(api.listPricingPlans()).resolves.toEqual({ plans });
    await expect(api.createPricingPlan(create.request)).resolves.toEqual({ plan: created });
    await api.updatePricingPlan(premium.id, edit.request);

    expect(calls).toEqual([
      { call: 'GET /api/admin/pricing-plans', body: undefined },
      { call: 'POST /api/admin/pricing-plans', body: create.request },
      {
        call: `PATCH /api/admin/pricing-plans/${premium.id}`,
        // Exactly the three editable fields: no model, rate, fee or duration.
        body: { name: 'Premium Commission', is_offered: true, is_default: true },
      },
    ]);
  });

  it('refuses a list the contract does not describe', async () => {
    const { api } = setup(() => ({ body: { plans: [{ ...basic, commission_rate: 101 }] } }));
    await expect(api.listPricingPlans()).rejects.toMatchObject({ code: 'UNEXPECTED_RESPONSE' });
  });

  it("passes the server's refusal on with its code", async () => {
    const { api } = setup(() => refusal(409, 'PRICING_PLAN_NAME_TAKEN'));
    await expect(
      api.updatePricingPlan(gold.id, {
        name: 'Basic Commission',
        is_offered: true,
        is_default: false,
      }),
    ).rejects.toMatchObject({ status: 409, code: 'PRICING_PLAN_NAME_TAKEN' });
  });
});

describe("the server's refusal of a plan", () => {
  it('puts a taken name on the name field', () => {
    expect(planSaveError(new ApiError(409, 'PRICING_PLAN_NAME_TAKEN', 'x'), 'create')).toEqual({
      field: 'name',
      message: 'Another plan already has this name.',
    });
  });

  it('puts the default rules on the default toggle, worded by what was attempted', () => {
    expect(planSaveError(new ApiError(409, 'DEFAULT_PLAN_REQUIRED', 'x'), 'create')).toEqual({
      field: 'isDefault',
      message: 'There is no default plan yet: the first plan must be the default.',
    });
    expect(planSaveError(new ApiError(409, 'DEFAULT_PLAN_REQUIRED', 'x'), 'edit')).toEqual({
      field: 'isDefault',
      message: 'A default plan is required. Make another Commission plan the default instead.',
    });
    expect(planSaveError(new ApiError(422, 'DEFAULT_PLAN_NOT_COMMISSION', 'x'), 'edit')).toEqual({
      field: 'isDefault',
      message: 'Only a Commission plan can be the default.',
    });
  });

  it('puts everything else on the form', () => {
    expect(planSaveError(new ApiError(404, 'PRICING_PLAN_NOT_FOUND', 'x'), 'edit')).toEqual({
      field: null,
      message: 'This plan no longer exists. Close and refresh the list.',
    });
    expect(planSaveError(new ApiError(400, 'VALIDATION_FAILED', 'x'), 'create').field).toBeNull();
    expect(planSaveError(new ApiError(0, 'NETWORK_ERROR', 'x'), 'create')).toEqual({
      field: null,
      message: 'The API cannot be reached. Try again.',
    });
    expect(planSaveError(new Error('boom'), 'edit')).toEqual({
      field: null,
      message: 'The plan could not be saved. Try again.',
    });
  });
});

describe('settlement contract', () => {
  it('accepts a shop with and without a primary bank account', () => {
    expect(settlementVendorViewSchema.safeParse(ready).success).toBe(true);
    expect(settlementVendorViewSchema.safeParse(held).success).toBe(true);
    expect(settlementVendorViewSchema.safeParse(noBank).success).toBe(true);
  });

  it('refuses a negative balance and a verification without a PAN', () => {
    expect(
      settlementVendorViewSchema.safeParse({ ...ready, available_for_payout_npr: -1 }).success,
    ).toBe(false);
    expect(settlementVendorViewSchema.safeParse({ ...ready, tax_id: null }).success).toBe(false);
  });

  it('takes a positive amount in whole paisa, a reference and an idempotency key', () => {
    const request = { amount_npr: 100.5, bank_reference: ' NIC-1 ', idempotency_key: KEY };
    const refuses = (body: unknown) => !settlementPayoutRequestSchema.safeParse(body).success;
    expect(settlementPayoutRequestSchema.parse(request).bank_reference).toBe('NIC-1');
    expect(refuses({ ...request, amount_npr: 0 })).toBe(true);
    expect(refuses({ ...request, amount_npr: 1.005 })).toBe(true);
    expect(refuses({ ...request, bank_reference: '  ' })).toBe(true);
    expect(refuses({ ...request, bank_reference: 'x'.repeat(101) })).toBe(true);
    expect(refuses({ amount_npr: 100.5, bank_reference: 'NIC-1' })).toBe(true);
    // The vendor is in the path; nothing in the body can force a payout.
    expect(refuses({ ...request, vendor_id: ready.vendor_id })).toBe(true);
    expect(refuses({ ...request, force: true })).toBe(true);
  });
});

describe('settlement rows', () => {
  const codShop: SettlementVendorView = {
    ...ready,
    vendor_id: '88888888-8888-4888-8888-888888888888',
    settlement_model: 'COD_CREDIT',
  };
  const empty: SettlementVendorView = {
    ...ready,
    vendor_id: '99999999-9999-4999-8999-999999999999',
    available_for_payout_npr: 0,
  };

  it('lists only escrow shops with a positive available balance', () => {
    expect(payableVendors([held, codShop, empty, ready]).map((vendor) => vendor.vendor_id)).toEqual(
      [ready.vendor_id, held.vendor_id],
    );
  });

  it('puts payable shops before held ones, the largest amount first within each', () => {
    const small = { ...ready, vendor_id: empty.vendor_id, available_for_payout_npr: 100 };
    expect(payableVendors([held, small, ready]).map((vendor) => vendor.vendor_id)).toEqual([
      ready.vendor_id,
      small.vendor_id,
      held.vendor_id,
    ]);
    // A shop without a bank account is held too, whatever its PAN.
    expect(payableVendors([noBank, small]).map((vendor) => vendor.vendor_id)).toEqual([
      small.vendor_id,
      noBank.vendor_id,
    ]);
  });

  it('totals what is ready and what is held', () => {
    expect(settlementTotals([ready, held, codShop, empty])).toEqual({
      readyNpr: 8450,
      heldNpr: 15400,
      heldCount: 1,
    });
    expect(settlementTotals([ready, held, noBank])).toMatchObject({ heldNpr: 17400, heldCount: 2 });
    expect(
      settlementTotals([
        { ...ready, available_for_payout_npr: 0.1 },
        { ...ready, vendor_id: empty.vendor_id, available_for_payout_npr: 0.2 },
      ]).readyNpr,
    ).toBe(0.3);
  });
});

describe('the payout gates', () => {
  it('enables Process Payout only for a verified PAN and a primary bank account', () => {
    expect(payoutButton(ready)).toEqual({ enabled: true, blockers: [], tooltip: null });
  });

  it('disables it with the exact tooltip while the PAN is not verified', () => {
    expect(payoutButton(held)).toEqual({
      enabled: false,
      blockers: ['PAN'],
      tooltip: 'Cannot disburse funds: PAN not verified.',
    });
    expect(PAN_NOT_VERIFIED_MESSAGE).toBe('Cannot disburse funds: PAN not verified.');
    // No PAN at all is not verified either.
    expect(payoutButton({ ...held, tax_id: null }).enabled).toBe(false);
  });

  it('disables it while the shop has no primary bank account', () => {
    expect(payoutButton(noBank)).toEqual({
      enabled: false,
      blockers: ['BANK'],
      tooltip: 'Cannot disburse funds: the vendor has no primary bank account.',
    });
  });

  it('names both gates, the PAN first, as the server checks them', () => {
    expect(payoutButton({ ...held, primary_bank_account: null })).toEqual({
      enabled: false,
      blockers: ['PAN', 'BANK'],
      tooltip: `${PAN_NOT_VERIFIED_MESSAGE} ${BANK_ACCOUNT_MISSING_MESSAGE}`,
    });
  });

  it('refuses the form for a held shop before looking at any field', () => {
    expect(validatePayoutForm(held, { amount: '100', bankReference: 'NIC-1' }, KEY)).toEqual({
      ok: false,
      errors: {},
      blocked: 'Cannot disburse funds: PAN not verified.',
    });
    expect(validatePayoutForm(noBank, { amount: '100', bankReference: 'NIC-1' }, KEY)).toEqual({
      ok: false,
      errors: {},
      blocked: BANK_ACCOUNT_MISSING_MESSAGE,
    });
  });
});

describe('the payout form', () => {
  it('opens on the whole available amount', () => {
    expect(payoutFormFor(ready)).toEqual({ amount: '8450', bankReference: '' });
    expect(payoutFormFor({ ...ready, available_for_payout_npr: 4200.5 }).amount).toBe('4200.5');
  });

  it('builds the request', () => {
    expect(
      validatePayoutForm(ready, { amount: ' 8450 ', bankReference: ' NIC-ASIA-778812 ' }, KEY),
    ).toEqual({
      ok: true,
      request: { amount_npr: 8450, bank_reference: 'NIC-ASIA-778812', idempotency_key: KEY },
    });
  });

  it('accepts exactly what is available and refuses one paisa more', () => {
    expect(validatePayoutForm(ready, { amount: '8450.00', bankReference: 'NIC-1' }, KEY).ok).toBe(
      true,
    );
    expect(validatePayoutForm(ready, { amount: '8450.01', bankReference: 'NIC-1' }, KEY)).toEqual({
      ok: false,
      errors: { amount: 'At most Rs. 8,450 is available.' },
      blocked: null,
    });
  });

  it('names each refused field', () => {
    expect(validatePayoutForm(ready, { amount: '0', bankReference: '  ' }, KEY)).toEqual({
      ok: false,
      errors: {
        amount: 'Enter an amount above 0.',
        bankReference: 'Enter the reference of the bank transfer, at most 100 characters.',
      },
      blocked: null,
    });
    expect(validatePayoutForm(ready, { amount: '12.345', bankReference: 'NIC-1' }, KEY).ok).toBe(
      false,
    );
    expect(validatePayoutForm(ready, { amount: '-5', bankReference: 'NIC-1' }, KEY).ok).toBe(false);
  });

  it('blames no field for a key the app built wrongly', () => {
    expect(validatePayoutForm(ready, { amount: '100', bankReference: 'NIC-1' }, 'short')).toEqual({
      ok: false,
      errors: {},
      blocked: 'The payout could not be prepared. Close and reopen.',
    });
  });
});

describe('createAdminApi (settlement endpoints)', () => {
  const request = { amount_npr: 8000.25, bank_reference: 'NIC-1', idempotency_key: KEY };
  const after = { ...ready, available_for_payout_npr: 449.75 };
  const answer = {
    payout: {
      id: STAMP.id,
      amount_npr: 8000.25,
      status: 'APPROVED',
      bank_reference: 'NIC-1',
      rejection_reason: null,
      requested_at: STAMP.now,
      decided_at: STAMP.now,
    },
    vendor: after,
    replayed: false,
  };

  it('lists the shops and records a payout with its idempotency key', async () => {
    const { calls, api } = setup((call) =>
      call.startsWith('GET')
        ? { body: { vendors: [ready, held, noBank] } }
        : { status: 201, body: answer },
    );

    await expect(api.listSettlements()).resolves.toEqual({ vendors: [ready, held, noBank] });
    await expect(api.processSettlementPayout(ready.vendor_id, request)).resolves.toEqual(answer);

    expect(calls).toEqual([
      { call: 'GET /api/admin/finance/settlements', body: undefined },
      // The vendor is in the path, never in the body.
      { call: `POST /api/admin/finance/settlements/${ready.vendor_id}/payout`, body: request },
    ]);
  });

  it('sends a retry with the same key and reads the replay', async () => {
    const { calls, api } = setup(() => ({ body: { ...answer, replayed: true } }));
    const first = await api.processSettlementPayout(ready.vendor_id, request);
    const second = await api.processSettlementPayout(ready.vendor_id, request);
    expect(first.replayed && second.replayed).toBe(true);
    expect(calls.map((call) => (call.body as { idempotency_key: string }).idempotency_key)).toEqual(
      [KEY, KEY],
    );
  });

  it.each([
    [422, 'PAN_NOT_VERIFIED'],
    [422, 'BANK_ACCOUNT_MISSING'],
    [422, 'INSUFFICIENT_BALANCE'],
  ])("passes the server's %i %s on with its code", async (status, code) => {
    const { api } = setup(() => refusal(status, code));
    await expect(api.processSettlementPayout(ready.vendor_id, request)).rejects.toMatchObject({
      status,
      code,
    });
  });

  it('puts the answered shop in place of its row and leaves the others alone', () => {
    expect(replaceSettlementVendor({ vendors: [held, ready] }, after)).toEqual({
      vendors: [held, after],
    });
    // A fully paid shop then drops out of the table.
    const emptied = replaceSettlementVendor(
      { vendors: [held, ready] },
      { ...ready, available_for_payout_npr: 0 },
    );
    expect(payableVendors(emptied.vendors).map((vendor) => vendor.vendor_id)).toEqual([
      held.vendor_id,
    ]);
  });
});

describe("the server's refusal of a payout", () => {
  it('names the gate that closed after the list was loaded', () => {
    expect(payoutSaveError(new ApiError(422, 'PAN_NOT_VERIFIED', 'x'))).toEqual({
      field: null,
      message: 'Cannot disburse funds: PAN not verified.',
    });
    expect(payoutSaveError(new ApiError(422, 'BANK_ACCOUNT_MISSING', 'x'))).toEqual({
      field: null,
      message: 'Cannot disburse funds: the vendor has no primary bank account.',
    });
  });

  it('puts a balance that fell on the amount field, with what is left', () => {
    expect(
      payoutSaveError(
        new ApiError(422, 'INSUFFICIENT_BALANCE', 'x', {
          requested_npr: 8450,
          available_balance_npr: 449.75,
        }),
      ),
    ).toEqual({ field: 'amount', message: 'Only Rs. 449.75 is available now.' });
    expect(payoutSaveError(new ApiError(422, 'INSUFFICIENT_BALANCE', 'x'))).toEqual({
      field: 'amount',
      message: 'The amount is more than what is available now.',
    });
  });

  it('explains the other refusals on the form', () => {
    for (const code of [
      'SETTLEMENT_MODEL_NOT_ESCROW',
      'IDEMPOTENCY_KEY_REUSED',
      'VENDOR_NOT_FOUND',
      'VALIDATION_FAILED',
    ]) {
      const result = payoutSaveError(new ApiError(409, code, 'x'));
      expect(result.field).toBeNull();
      expect(result.message).not.toBe('The payout could not be recorded. Try again.');
    }
    expect(payoutSaveError(new ApiError(0, 'NETWORK_ERROR', 'x')).message).toBe(
      'The API cannot be reached. Try again: the same attempt is never recorded twice.',
    );
    expect(payoutSaveError(new Error('boom'))).toEqual({
      field: null,
      message: 'The payout could not be recorded. Try again.',
    });
  });
});
