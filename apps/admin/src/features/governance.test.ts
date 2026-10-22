import { createAdminApi } from '../api/admin-api';
import { ApiError, createApiClient, type FetchLike } from '../api/client';
import { fakeAdminApi, refusalOf } from '../api/fake-admin-api';
import { createSessionStore } from '../auth/session-store';
import { TAB_GROUPS, TABS, tabFromHash, vendorTabFromHash } from '../tabs';
import {
  adminCampaignViewSchema,
  campaignPhase,
  campaignSaveErrorMessage,
  campaignWriteRequestSchema,
  discountLabel,
  emptyCampaignForm,
  formFromCampaign,
  fundingLabel,
  publishRequest,
  termsChanged,
  termsChangeWarning,
  validateCampaignForm,
  type AdminCampaignView,
  type CampaignFormValues,
  type CampaignWrite,
} from './campaigns/campaign-rules';
import {
  COMPLIANCE_FILTERS,
  complianceRows,
  complianceVendorViewSchema,
  countByStanding,
  panStandingOf,
  replaceComplianceVendor,
  verifyButton,
  verifyErrorMessage,
  type ComplianceVendorView,
} from './compliance/compliance-rules';

const ADMIN_ID = '99999999-9999-4999-8999-999999999999';

const live: ComplianceVendorView = {
  id: '11111111-1111-4111-8111-111111111111',
  business_name: 'Asan Masala & Snacks',
  phone: '+9779800000015',
  municipality_palika_string: 'Kathmandu Metropolitan City',
  status: 'LIVE',
  restore_status: null,
  compliance_suspended_at: null,
  legal_name: null,
  tax_id: '301456789',
  is_vat_registered: false,
  pan_verified_at: null,
  has_pan_document: false,
};

const swept: ComplianceVendorView = {
  ...live,
  id: '22222222-2222-4222-8222-222222222222',
  business_name: 'Boudha Fresh Mart',
  status: 'SUSPENDED_COMPLIANCE',
  restore_status: 'LIVE',
  compliance_suspended_at: '2026-10-01T18:15:00.000Z',
  tax_id: null,
};

const sweptLater: ComplianceVendorView = {
  ...swept,
  id: '33333333-3333-4333-8333-333333333333',
  business_name: 'Aama Ko Pasal',
  compliance_suspended_at: '2026-10-04T18:15:00.000Z',
};

const indebted: ComplianceVendorView = {
  ...live,
  id: '44444444-4444-4444-8444-444444444444',
  business_name: 'Bhaktapur Durbar Sweets',
  status: 'SUSPENDED',
  tax_id: null,
};

/** A seeded shop from before the PAN rule: LIVE with no PAN until the nightly sweep suspends it. */
const legacy: ComplianceVendorView = {
  ...live,
  id: '88888888-8888-4888-8888-888888888888',
  business_name: 'Patan Organic Store',
  tax_id: null,
};

const verified: ComplianceVendorView = {
  ...live,
  id: '55555555-5555-4555-8555-555555555555',
  business_name: 'Thamel Kirana Pasal',
  pan_verified_at: '2026-09-28T07:30:00.000Z',
};

const campaign: AdminCampaignView = {
  id: '66666666-6666-4666-8666-666666666666',
  name: 'Dashain 10%',
  kind: 'PERCENTAGE',
  value: 10,
  max_discount_npr: 150,
  min_cart_npr: 500,
  vendor_share_percent: 50,
  terms_version: 2,
  starts_at: '2026-09-30T18:15:00.000Z',
  ends_at: '2026-10-25T18:14:59.000Z',
  is_active: true,
  opt_in_count: 3,
  created_at: '2026-09-20T06:00:00.000Z',
  updated_at: '2026-09-27T09:30:00.000Z',
};

const form: CampaignFormValues = {
  name: '  Tihar 15%  ',
  kind: 'PERCENTAGE',
  value: '15',
  maxDiscount: '200',
  minCart: '750.50',
  vendorSharePercent: '40',
  startsOn: '2026-11-05',
  endsOn: '2026-11-12',
  isActive: true,
};

const STAMP = { id: '77777777-7777-4777-8777-777777777777', now: '2026-10-07T06:00:00.000Z' };

function requestOf(values: CampaignFormValues): CampaignWrite {
  const result = validateCampaignForm(values);
  if (!result.ok) throw new Error(`form refused: ${JSON.stringify(result.errors)}`);
  return result.request;
}

describe('tabs', () => {
  it('lists the dashboard sections in order, the new ones included', () => {
    expect(TABS.map((tab) => tab.id)).toEqual([
      'dashboard',
      'vendors',
      'onboarding',
      'compliance',
      'approvals',
      'disputes',
      'categories',
      'products',
      'campaigns',
      'ad-products',
      'promotions',
      'settlements',
      'payouts',
      'pricing-plans',
      'logistics',
      'notifications',
      'tutorials',
      'exports',
      'dlq',
      'auth-logs',
      'audit-log',
    ]);
  });

  it('groups the sections for the sidebar, every section once and in order', () => {
    expect(TAB_GROUPS.map((group) => group.name)).toEqual([
      'Overview',
      'Shops',
      'Catalogue',
      'Marketing',
      'Money',
      'Platform',
    ]);
    expect(TAB_GROUPS.flatMap((group) => group.tabs.map((tab) => tab.id))).toEqual(
      TABS.map((tab) => tab.id),
    );
  });

  it('opens every section by its hash and the Dashboard otherwise', () => {
    for (const tab of TABS) expect(tabFromHash(`#/${tab.id}`)).toBe(tab.id);
    expect(tabFromHash('')).toBe('dashboard');
    expect(tabFromHash('#/compliance/extra')).toBe('dashboard');
    // An admin section is not a vendor section.
    expect(vendorTabFromHash('#/campaigns')).toBe('my-products');
  });
});

describe('compliance contract', () => {
  it('accepts a row of every standing', () => {
    for (const vendor of [live, swept, sweptLater, indebted, verified]) {
      expect(complianceVendorViewSchema.safeParse(vendor).success).toBe(true);
    }
  });

  it('accepts a LIVE vendor without a PAN: the sweep has not reached it yet', () => {
    expect(complianceVendorViewSchema.safeParse(legacy).success).toBe(true);
  });

  it('refuses a compliance suspension that remembers no status, and nothing else about it', () => {
    expect(complianceVendorViewSchema.safeParse({ ...swept, restore_status: null }).success).toBe(
      false,
    );
    // Put there without the sweep (no audit entry): the time is unknown.
    expect(
      complianceVendorViewSchema.safeParse({ ...swept, compliance_suspended_at: null }).success,
    ).toBe(true);
    // A debt or admin suspension laid on top of a compliance one keeps the remembered status.
    expect(
      complianceVendorViewSchema.safeParse({ ...indebted, restore_status: 'LIVE' }).success,
    ).toBe(true);
  });

  it('takes a PAN of exactly nine digits and no verification without one', () => {
    expect(complianceVendorViewSchema.safeParse({ ...live, tax_id: '30145678' }).success).toBe(
      false,
    );
    expect(complianceVendorViewSchema.safeParse({ ...live, tax_id: '3014567890' }).success).toBe(
      false,
    );
    expect(
      complianceVendorViewSchema.safeParse({
        ...indebted,
        pan_verified_at: '2026-10-01T00:00:00.000Z',
      }).success,
    ).toBe(false);
  });
});

describe('compliance rules', () => {
  const all = [verified, live, indebted, sweptLater, swept];

  it('derives the PAN standing', () => {
    expect(panStandingOf(swept)).toBe('SUSPENDED');
    expect(panStandingOf(indebted)).toBe('MISSING');
    expect(panStandingOf(live)).toBe('UNVERIFIED');
    expect(panStandingOf(verified)).toBe('VERIFIED');
    expect(countByStanding(all)).toEqual({ SUSPENDED: 2, MISSING: 1, UNVERIFIED: 1, VERIFIED: 1 });
  });

  it('shows a LIVE shop without a PAN as missing, with nothing to verify', () => {
    expect(panStandingOf(legacy)).toBe('MISSING');
    expect(complianceRows([verified, legacy, live], 'MISSING', '')).toEqual([legacy]);
    expect(verifyButton(legacy)).toEqual({
      label: 'Verify document',
      enabled: false,
      note: 'No PAN on file. The compliance sweep takes this shop offline until its PAN is verified.',
    });
  });

  it('opens on the shops suspended for compliance and ends on All', () => {
    expect(COMPLIANCE_FILTERS[0]?.standing).toBe('SUSPENDED');
    expect(COMPLIANCE_FILTERS.at(-1)?.standing).toBeUndefined();
  });

  it('lists the worst standing first, the longest suspension first among the suspended', () => {
    expect(complianceRows(all, undefined, '').map((vendor) => vendor.id)).toEqual([
      swept.id,
      sweptLater.id,
      indebted.id,
      live.id,
      verified.id,
    ]);
    expect(complianceRows(all, 'SUSPENDED', '').map((vendor) => vendor.id)).toEqual([
      swept.id,
      sweptLater.id,
    ]);
  });

  it('searches the name, phone, Palika and PAN without regard to case', () => {
    expect(complianceRows(all, undefined, ' BOUDHA ').map((vendor) => vendor.id)).toEqual([
      swept.id,
    ]);
    expect(complianceRows(all, undefined, '301456789')).toHaveLength(2);
    expect(complianceRows(all, 'VERIFIED', 'boudha')).toEqual([]);
  });

  it('offers verification only for a PAN that is on file, unchecked and has its document', () => {
    // A LIVE shop with an unchecked PAN predates the 2026-10-20 rule: the sweep takes it offline.
    expect(verifyButton({ ...live, has_pan_document: true })).toEqual({
      label: 'Verify document',
      enabled: true,
      note: 'LIVE without a verified PAN: the compliance sweep takes it offline. Verify to keep it trading.',
    });
    expect(verifyButton({ ...live, status: 'APPROVED', has_pan_document: true }).note).toBe(
      'The shop cannot go LIVE, and its payouts are held, until the PAN is verified.',
    );
    // Phase 35: a number without its certificate is not something an admin can check.
    expect(verifyButton(live)).toEqual({
      label: 'Verify document',
      enabled: false,
      note: 'No document uploaded. The vendor uploads its PAN certificate in the Vendor App; there is nothing to verify until then. The shop cannot go LIVE and its payouts are held.',
    });
    expect(verifyErrorMessage(new ApiError(422, 'DOCUMENT_MISSING', 'x'))).toBe(
      'This vendor has no PAN document on file (a changed PAN number removes the old one). The list has been refreshed.',
    );
    expect(verifyButton(verified)).toEqual({
      label: 'Verified',
      enabled: false,
      note: 'Checked 2026-09-28 13:15:00.',
    });
  });

  it('lifts a compliance suspension only by verifying a PAN and certificate on file (2026-10-20)', () => {
    // No PAN yet: nothing to verify.
    expect(verifyButton(swept)).toEqual({
      label: 'Verify document',
      enabled: false,
      note: 'Offline: no PAN on file. The vendor adds its PAN and certificate in the Vendor App; verifying them restores the shop to LIVE.',
    });
    // A PAN without its certificate: still nothing to verify.
    const withPan = { ...swept, tax_id: '301456789' };
    expect(verifyButton(withPan)).toEqual({
      label: 'Verify document',
      enabled: false,
      note: 'Offline: no certificate uploaded for this PAN yet. Verifying it, once uploaded, restores the shop to LIVE.',
    });
    // Both on file: the verification is the way back.
    expect(verifyButton({ ...withPan, has_pan_document: true })).toEqual({
      label: 'Verify document',
      enabled: true,
      note: 'Offline until verified. Verifying restores the shop to LIVE and issues its waiting invoices.',
    });
  });

  it('warns that a debt-suspended shop without a PAN will not return to LIVE', () => {
    expect(verifyButton(indebted)).toEqual({
      label: 'Verify document',
      enabled: false,
      note: 'No PAN on file. When this suspension is lifted the shop moves to SUSPENDED_COMPLIANCE, not LIVE.',
    });
    expect(verifyButton({ ...indebted, status: 'APPROVED' }).note).toBe(
      'No PAN on file. The shop cannot go LIVE without a verified PAN.',
    );
  });

  it("puts the server's answer in place of the one row and leaves the others alone", () => {
    const stamped = { ...live, pan_verified_at: '2026-10-07T06:00:00.000Z' };
    const next = replaceComplianceVendor({ vendors: all }, stamped);
    expect(next.vendors.find((vendor) => vendor.id === live.id)).toEqual(stamped);
    expect(next.vendors.filter((vendor) => vendor.id !== live.id)).toEqual(
      all.filter((vendor) => vendor.id !== live.id),
    );
    // A vendor that is not in the list is not added.
    expect(replaceComplianceVendor({ vendors: [swept] }, stamped)).toEqual({ vendors: [swept] });
  });

  it('explains a refused verification', () => {
    expect(verifyErrorMessage(new ApiError(409, 'PAN_MISSING', 'x'))).toBe(
      'This vendor has no PAN on file any more. The list has been refreshed.',
    );
    expect(verifyErrorMessage(new ApiError(404, 'VENDOR_NOT_FOUND', 'x'))).toBe(
      'This vendor no longer exists.',
    );
    expect(verifyErrorMessage(new ApiError(0, 'NETWORK_ERROR', 'x'))).toBe(
      'The API cannot be reached. Try again.',
    );
    expect(verifyErrorMessage(new Error('boom'))).toBe(
      'The verification could not be saved. Try again.',
    );
  });
});

describe('createAdminApi (compliance endpoints)', () => {
  function setup(respond: (url: string) => unknown) {
    const calls: { call: string; body: BodyInit | null | undefined }[] = [];
    const fetch: FetchLike = (url, init) => {
      calls.push({ call: `${init.method ?? ''} ${url}`, body: init.body });
      return Promise.resolve(new Response(JSON.stringify(respond(url)), { status: 200 }));
    };
    const session = createSessionStore();
    session.getState().setSession({
      phone: '+9779800000099',
      user: { id: ADMIN_ID, role: 'SUPER_ADMIN', first_name: null },
      accessToken: 'access-1',
    });
    return { calls, api: createAdminApi(createApiClient({ baseUrl: '', fetch, session })) };
  }

  it('lists the vendors and verifies a PAN without a body', async () => {
    const stamped = { ...live, pan_verified_at: '2026-10-07T06:00:00.000Z' };
    const { calls, api } = setup((url) =>
      url.endsWith('/pan-verification') ? { vendor: stamped } : { vendors: [swept, legacy, live] },
    );

    await expect(api.listComplianceVendors()).resolves.toEqual({ vendors: [swept, legacy, live] });
    await expect(api.verifyVendorPan(live.id)).resolves.toEqual({ vendor: stamped });

    expect(calls).toEqual([
      { call: 'GET /api/admin/compliance/vendors', body: undefined },
      { call: `POST /api/admin/vendors/${live.id}/pan-verification`, body: undefined },
    ]);
  });

  it('refuses a row the database could not hold', async () => {
    const { api } = setup(() => ({ vendors: [{ ...swept, restore_status: null }] }));
    await expect(api.listComplianceVendors()).rejects.toMatchObject({
      code: 'UNEXPECTED_RESPONSE',
    });
  });
});

describe('campaign contract', () => {
  it('accepts a campaign as the server lists it', () => {
    expect(adminCampaignViewSchema.safeParse(campaign).success).toBe(true);
  });

  it('has no way to name a shop, an opt-in or a terms version', () => {
    const request = publishRequest(campaign, true);
    expect(campaignWriteRequestSchema.safeParse(request).success).toBe(true);
    for (const extra of [
      { vendor_ids: [campaign.id] },
      { vendor_id: campaign.id },
      { opt_in: true },
      { opted_in_vendor_ids: [campaign.id] },
      { terms_version: 7 },
    ]) {
      expect(campaignWriteRequestSchema.safeParse({ ...request, ...extra }).success).toBe(false);
    }
  });

  it('keeps the vendor share between 0 and 100', () => {
    const request = publishRequest(campaign, true);
    const withShare = (share: number) =>
      campaignWriteRequestSchema.safeParse({ ...request, vendor_share_percent: share }).success;
    expect(withShare(0)).toBe(true);
    expect(withShare(100)).toBe(true);
    expect(withShare(-0.01)).toBe(false);
    expect(withShare(100.01)).toBe(false);
  });

  it('refuses a percentage above 100, a cap on a flat discount and an end before the start', () => {
    const request = publishRequest(campaign, true);
    expect(campaignWriteRequestSchema.safeParse({ ...request, value: 100 }).success).toBe(true);
    expect(campaignWriteRequestSchema.safeParse({ ...request, value: 100.5 }).success).toBe(false);
    expect(campaignWriteRequestSchema.safeParse({ ...request, kind: 'FLAT' }).success).toBe(false);
    expect(
      campaignWriteRequestSchema.safeParse({ ...request, ends_at: request.starts_at }).success,
    ).toBe(false);
  });
});

describe('campaign form', () => {
  it('starts unpublished and fully funded by the platform', () => {
    expect(emptyCampaignForm()).toMatchObject({ isActive: false, vendorSharePercent: '0' });
  });

  it('builds the request, with the days as whole Nepal Time days', () => {
    expect(requestOf(form)).toEqual({
      name: 'Tihar 15%',
      kind: 'PERCENTAGE',
      value: 15,
      max_discount_npr: 200,
      min_cart_npr: 750.5,
      vendor_share_percent: 40,
      // 00:00:00 and 23:59:59 at UTC+05:45.
      starts_at: '2026-11-04T18:15:00.000Z',
      ends_at: '2026-11-12T18:14:59.000Z',
      is_active: true,
    });
  });

  it('allows a one-day campaign and no cap', () => {
    const request = requestOf({ ...form, endsOn: form.startsOn, maxDiscount: ' ' });
    expect(request.max_discount_npr).toBeNull();
    expect(request.ends_at).toBe('2026-11-05T18:14:59.000Z');
  });

  it('drops a cap left in the field when the discount is flat', () => {
    expect(requestOf({ ...form, kind: 'FLAT', value: '100' }).max_discount_npr).toBeNull();
  });

  it('names each refused field', () => {
    expect(
      validateCampaignForm({
        ...form,
        name: '   ',
        value: 'ten',
        maxDiscount: '0',
        minCart: '-1',
        vendorSharePercent: '101',
        startsOn: '',
        endsOn: '2026-02-30',
      }),
    ).toEqual({
      ok: false,
      errors: {
        name: 'Enter a name of at most 80 characters.',
        value: 'Enter a percentage above 0, up to 100.',
        maxDiscount: 'Enter an amount above 0, or leave it empty for no cap.',
        minCart: 'Enter an amount of 0 or more.',
        vendorSharePercent: 'Enter a percentage from 0 to 100.',
        startsOn: 'Choose the first day.',
        endsOn: 'Choose a last day on or after the first day.',
      },
    });
  });

  it('refuses a percentage above 100 once the other fields are in order', () => {
    expect(validateCampaignForm({ ...form, value: '150' })).toEqual({
      ok: false,
      errors: { value: 'Enter a percentage above 0, up to 100.' },
    });
  });

  it('refuses a last day before the first, three decimals and a zero flat amount', () => {
    expect(validateCampaignForm({ ...form, endsOn: '2026-11-04' })).toEqual({
      ok: false,
      errors: { endsOn: 'Choose a last day on or after the first day.' },
    });
    expect(validateCampaignForm({ ...form, vendorSharePercent: '33.333' }).ok).toBe(false);
    expect(validateCampaignForm({ ...form, kind: 'FLAT', value: '0' })).toEqual({
      ok: false,
      errors: { value: 'Enter an amount above 0.' },
    });
  });

  it('round-trips a campaign through the form unchanged', () => {
    expect(formFromCampaign(campaign)).toMatchObject({
      startsOn: '2026-10-01',
      endsOn: '2026-10-25',
    });
    expect(requestOf(formFromCampaign(campaign))).toEqual(publishRequest(campaign, true));
  });
});

describe('campaign terms and opt-ins', () => {
  const same = publishRequest(campaign, true);

  it('treats the discount, cap, minimum cart and vendor share as terms', () => {
    expect(termsChanged(campaign, same)).toBe(false);
    expect(termsChanged(campaign, { ...same, vendor_share_percent: 60 })).toBe(true);
    expect(termsChanged(campaign, { ...same, value: 12 })).toBe(true);
    expect(termsChanged(campaign, { ...same, max_discount_npr: null })).toBe(true);
    expect(termsChanged(campaign, { ...same, min_cart_npr: 0 })).toBe(true);
    expect(termsChanged(campaign, { ...same, kind: 'FLAT', max_discount_npr: null })).toBe(true);
  });

  it('treats both dates as terms: shifting or shortening a campaign voids the opt-ins', () => {
    expect(termsChanged(campaign, { ...same, ends_at: '2026-10-20T18:14:59.000Z' })).toBe(true);
    expect(termsChanged(campaign, { ...same, ends_at: '2026-10-30T18:14:59.000Z' })).toBe(true);
    expect(termsChanged(campaign, { ...same, starts_at: '2026-10-02T18:15:00.000Z' })).toBe(true);
  });

  it('does not treat the name or publishing as terms', () => {
    expect(termsChanged(campaign, { ...same, name: 'Dashain Dhamaka', is_active: false })).toBe(
      false,
    );
    expect(termsChangeWarning(campaign, { ...same, is_active: false })).toBeNull();
  });

  it('warns before changed terms close the current opt-ins', () => {
    expect(termsChangeWarning(campaign, { ...same, vendor_share_percent: 60 })).toBe(
      'These changes raise the terms to version 3. 3 shops opted in to version 2: their opt-ins are closed and the campaign stops applying to them until they opt in again. Orders already priced keep their terms.',
    );
    expect(
      termsChangeWarning({ ...campaign, opt_in_count: 1 }, { ...same, vendor_share_percent: 60 }),
    ).toBe(
      'These changes raise the terms to version 3. 1 shop opted in to version 2: its opt-in is closed and the campaign stops applying to it until it opts in again. Orders already priced keep their terms.',
    );
    expect(
      termsChangeWarning({ ...campaign, opt_in_count: 0 }, { ...same, vendor_share_percent: 60 }),
    ).toBe(
      'These changes raise the terms to version 3. No shop has opted in yet. Orders already priced keep their terms.',
    );
  });
});

describe('createAdminApi (campaign endpoints)', () => {
  // What the server answers after a changed term: the version raised and every opt-in voided.
  const raised = { ...campaign, vendor_share_percent: 60, terms_version: 3, opt_in_count: 0 };

  it('lists, creates and replaces campaigns under /api/admin/campaigns', async () => {
    const { calls, api } = fakeAdminApi((call) =>
      call.startsWith('GET')
        ? { body: { campaigns: [campaign] } }
        : { body: { campaign: call.startsWith('PUT') ? raised : { ...campaign, id: STAMP.id } } },
    );
    const created = requestOf(form);
    const edited = { ...publishRequest(campaign, true), vendor_share_percent: 60 };

    await expect(api.listCampaigns()).resolves.toEqual({ campaigns: [campaign] });
    await api.createCampaign(created);
    // The version and the opt-in count come from the server's answer, never from the request.
    await expect(api.updateCampaign(campaign.id, edited)).resolves.toEqual({ campaign: raised });

    expect(calls).toEqual([
      { call: 'GET /api/admin/campaigns', body: undefined },
      { call: 'POST /api/admin/campaigns', body: created },
      { call: `PUT /api/admin/campaigns/${campaign.id}`, body: edited },
    ]);
    for (const { body } of calls.slice(1)) {
      expect(Object.keys(body as object)).not.toEqual(
        expect.arrayContaining(['terms_version', 'opt_in_count', 'vendor_id']),
      );
      expect(body).not.toHaveProperty('terms_version');
      expect(body).not.toHaveProperty('vendor_id');
    }
  });

  it('publishes with the terms untouched, so the server voids nothing', async () => {
    const { calls, api } = fakeAdminApi(() => ({ body: { campaign } }));
    await api.updateCampaign(campaign.id, publishRequest(campaign, false));
    const sent = calls[0]?.body as CampaignWrite;
    expect(sent.is_active).toBe(false);
    expect(termsChanged(campaign, sent)).toBe(false);
  });

  it("passes the server's refusal on and words it", async () => {
    const { api } = fakeAdminApi(() => refusalOf(404, 'CAMPAIGN_NOT_FOUND'));
    const error: unknown = await api
      .updateCampaign(campaign.id, publishRequest(campaign, true))
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ status: 404, code: 'CAMPAIGN_NOT_FOUND' });
    expect(campaignSaveErrorMessage(error)).toBe(
      'This campaign no longer exists. Close and refresh the list.',
    );
    expect(campaignSaveErrorMessage(new ApiError(400, 'VALIDATION_FAILED', 'x'))).toBe(
      'The server refused this campaign. Check the fields.',
    );
    expect(campaignSaveErrorMessage(new ApiError(0, 'NETWORK_ERROR', 'x'))).toBe(
      'The API cannot be reached. Try again.',
    );
    expect(campaignSaveErrorMessage(new Error('boom'))).toBe(
      'The campaign could not be saved. Try again.',
    );
  });
});

describe('campaign display', () => {
  it('tells unpublished, scheduled, running and ended apart', () => {
    expect(campaignPhase(campaign, '2026-09-29T00:00:00.000Z')).toBe('SCHEDULED');
    expect(campaignPhase(campaign, campaign.starts_at)).toBe('OPEN');
    expect(campaignPhase(campaign, '2026-10-07T00:00:00.000Z')).toBe('OPEN');
    expect(campaignPhase({ ...campaign, is_active: false }, '2026-10-07T00:00:00.000Z')).toBe(
      'UNPUBLISHED',
    );
    expect(campaignPhase(campaign, campaign.ends_at)).toBe('ENDED');
    expect(campaignPhase({ ...campaign, is_active: false }, '2026-11-01T00:00:00.000Z')).toBe(
      'ENDED',
    );
  });

  it('words the discount and who funds it', () => {
    expect(discountLabel(campaign)).toBe('10% off, up to Rs. 150');
    expect(discountLabel({ ...campaign, max_discount_npr: null })).toBe('10% off');
    expect(discountLabel({ kind: 'FLAT', value: 100, max_discount_npr: null })).toBe('Rs. 100 off');
    expect(fundingLabel(50)).toBe('Vendor bears 50% · platform funds 50%');
    expect(fundingLabel(33.33)).toBe('Vendor bears 33.33% · platform funds 66.67%');
    expect(fundingLabel(0)).toBe('Platform funds 100%');
    expect(fundingLabel(100)).toBe('Vendor bears 100%');
  });
});
