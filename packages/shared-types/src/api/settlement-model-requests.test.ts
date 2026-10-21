import { adPurchaseStatuses, settlementModelRequestStatuses } from '../domain/enums';
import {
  adminModelChangeRejectRequestSchema,
  adminModelChangeRequestListQuerySchema,
  modelChangeBlockersOf,
  modelChangeRequestViewSchema,
  settlementModelChangeRequestSchema,
  vendorCampaignViewSchema,
} from './settlement-model-requests';

const request = {
  id: '11111111-1111-4111-8111-111111111111',
  vendor_id: '22222222-2222-4222-8222-222222222222',
  business_name: 'Kirtipur Kirana Pasal',
  phone: '+9779800000020',
  current_model: 'PLATFORM_ESCROW',
  from_model: 'PLATFORM_ESCROW',
  requested_model: 'COD_CREDIT',
  status: 'PENDING',
  requested_at: '2026-10-08T05:30:00.000Z',
  open_order_count: 0,
  ledger_balance_npr: 0,
  active_ad_count: 0,
  decided_at: null,
  rejection_reason: null,
} as const;

const campaign = {
  id: '33333333-3333-4333-8333-333333333333',
  name: 'Dashain 10%',
  kind: 'PERCENTAGE',
  value: 10,
  max_discount_npr: 150,
  min_cart_npr: 500,
  vendor_share_percent: 50,
  terms_version: 2,
  starts_at: '2026-09-30T18:15:00.000Z',
  ends_at: '2026-10-25T18:14:59.000Z',
  opt_in_status: null,
  opt_in_terms_version: null,
  opted_in_at: null,
} as const;

describe('settlement model change requests', () => {
  it('has three request statuses and four ad purchase statuses', () => {
    expect(settlementModelRequestStatuses).toEqual(['PENDING', 'APPROVED', 'REJECTED']);
    expect(adPurchaseStatuses).toEqual(['ACTIVE', 'PAUSED', 'ENDED', 'CANCELLED']);
  });

  it("takes the vendor's request as a model and nothing else", () => {
    const accepts = (body: unknown) => settlementModelChangeRequestSchema.safeParse(body).success;
    expect(accepts({ model: 'COD_CREDIT' })).toBe(true);
    // Model C is a value of the enum: the service refuses it, with its own code.
    expect(accepts({ model: 'DIRECT_PREPAID' })).toBe(true);
    expect(accepts({})).toBe(false);
    expect(accepts({ model: 'FREE' })).toBe(false);
    expect(accepts({ model: 'COD_CREDIT', vendor_id: request.vendor_id })).toBe(false);
    expect(accepts({ model: 'COD_CREDIT', status: 'APPROVED' })).toBe(false);
  });

  it('describes a request whose decision adds up', () => {
    const accepts = (view: unknown) => modelChangeRequestViewSchema.safeParse(view).success;
    expect(accepts(request)).toBe(true);
    expect(accepts({ ...request, requested_model: 'PLATFORM_ESCROW' })).toBe(false);
    expect(accepts({ ...request, decided_at: '2026-10-08T06:00:00.000Z' })).toBe(false);
    expect(accepts({ ...request, status: 'APPROVED' })).toBe(false);
    expect(accepts({ ...request, rejection_reason: 'No' })).toBe(false);
    expect(
      accepts({
        ...request,
        status: 'REJECTED',
        decided_at: '2026-10-08T06:00:00.000Z',
        rejection_reason: 'Dues outstanding',
      }),
    ).toBe(true);
    expect(accepts({ ...request, open_order_count: -1 })).toBe(false);
  });

  it('names what stands in the way: open orders, a ledger below 0, a running ad', () => {
    expect(modelChangeBlockersOf(request)).toEqual([]);
    expect(modelChangeBlockersOf({ ...request, ledger_balance_npr: 0.01 })).toEqual([]);
    expect(
      modelChangeBlockersOf({
        requested_model: 'PLATFORM_ESCROW',
        open_order_count: 2,
        ledger_balance_npr: -0.01,
        active_ad_count: 1,
      }),
    ).toEqual(['OPEN_ORDERS', 'NEGATIVE_BALANCE', 'ACTIVE_AD']);
  });

  it('asks a move to Model C for the Fixed Reserve, and no other model', () => {
    const prepaid = { ...request, requested_model: 'DIRECT_PREPAID' as const };
    expect(modelChangeBlockersOf({ ...prepaid, ledger_balance_npr: 4999.99 })).toEqual([
      'BELOW_PREPAID_RESERVE',
    ]);
    expect(modelChangeBlockersOf({ ...prepaid, ledger_balance_npr: 5000 })).toEqual([]);
    expect(modelChangeBlockersOf({ ...prepaid, ledger_balance_npr: 7000 }, 8000)).toEqual([
      'BELOW_PREPAID_RESERVE',
    ]);
    expect(modelChangeBlockersOf({ ...request, ledger_balance_npr: 10 })).toEqual([]);
  });

  it('lets a rejection carry a reason and no decision carry a model', () => {
    const parse = (body: unknown) => adminModelChangeRejectRequestSchema.safeParse(body);
    expect(parse({}).data).toEqual({ reason: null });
    expect(parse({ reason: '   ' }).data).toEqual({ reason: null });
    expect(parse({ reason: null }).data).toEqual({ reason: null });
    expect(parse({ reason: '  Dues outstanding ' }).data).toEqual({ reason: 'Dues outstanding' });
    expect(parse({ reason: 'x'.repeat(501) }).success).toBe(false);
    expect(parse({ model: 'COD_CREDIT' }).success).toBe(false);
    expect(parse({ reason: 'No', requested_model: 'COD_CREDIT' }).success).toBe(false);
  });

  it('filters the admin list by a known status only', () => {
    expect(adminModelChangeRequestListQuerySchema.safeParse({}).success).toBe(true);
    expect(adminModelChangeRequestListQuerySchema.safeParse({ status: 'PENDING' }).success).toBe(
      true,
    );
    expect(adminModelChangeRequestListQuerySchema.safeParse({ status: 'DONE' }).success).toBe(
      false,
    );
    expect(adminModelChangeRequestListQuerySchema.safeParse({ vendor_id: 'x' }).success).toBe(
      false,
    );
  });
});

describe("the vendor's view of a campaign", () => {
  it('shows the terms to agree to and where the shop stands', () => {
    const accepts = (view: unknown) => vendorCampaignViewSchema.safeParse(view).success;
    expect(accepts(campaign)).toBe(true);
    expect(
      accepts({
        ...campaign,
        opt_in_status: 'ACTIVE',
        opt_in_terms_version: 2,
        opted_in_at: '2026-10-01T04:00:00.000Z',
      }),
    ).toBe(true);
    expect(accepts({ ...campaign, opt_in_status: 'VOIDED', opt_in_terms_version: 1 })).toBe(true);
    expect(accepts({ ...campaign, opt_in_status: 'ENROLLED' })).toBe(false);
    // Nothing about other shops, and nothing an admin sees.
    expect(accepts({ ...campaign, opt_in_count: 3 })).toBe(false);
    expect(accepts({ ...campaign, is_active: true })).toBe(false);
  });
});
