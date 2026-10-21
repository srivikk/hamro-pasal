import { createAdminApi } from '../api/admin-api';
import { ApiError, createApiClient, type FetchLike } from '../api/client';
import { fakeAdminApi, refusalOf } from '../api/fake-admin-api';
import { createSessionStore } from '../auth/session-store';
import { TABS, tabFromHash } from '../tabs';
import {
  AD_SLOT_LABELS,
  AD_SLOTS_ON_SALE,
  adPriceLabel,
  adProductCreateRequestSchema,
  adProductRows,
  adProductSaveErrorMessage,
  adProductUpdateRequestSchema,
  adProductViewSchema,
  emptyAdProductForm,
  formFromAdProduct,
  offSaleNote,
  PRICE_FIELD_LABELS,
  validateAdProductEdit,
  validateNewAdProduct,
  type AdProductFormValues,
  type AdProductView,
} from './ads/ad-product-rules';
import {
  approveButton,
  blockersOf,
  decisionErrorMessage,
  MODEL_CHANGE_FILTERS,
  modelChangeRequestViewSchema,
  modelChangeRows,
  replaceModelChangeRequest,
  SETTLEMENT_MODEL_LABELS,
  validateDecision,
  type ModelChangeRequestView,
} from './approvals/approval-rules';
import {
  EMERGENCY_STOP_WARNING,
  feeChangeNote,
  freeDeliveryChangeNote,
  formFromLogistics,
  isEmergencyStop,
  logisticsChanged,
  logisticsErrorMessage,
  logisticsSettingsViewSchema,
  logisticsSettingsWriteSchema,
  modeDisableWarning,
  validateLogisticsForm,
  type LogisticsSettingsView,
  type LogisticsSettingsWrite,
} from './logistics/logistics-rules';

const STAMP = { id: '99999999-9999-4999-8999-999999999999', now: '2026-10-07T06:00:00.000Z' };

const carousel: AdProductView = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Carousel Placement',
  slot: 'CAROUSEL',
  billing_model: 'FLAT_RATE',
  price_npr: 5000,
  duration_days: 7,
  is_active: true,
  active_purchase_count: 2,
  created_at: '2026-09-15T06:00:00.000Z',
};

const search: AdProductView = {
  ...carousel,
  id: '22222222-2222-4222-8222-222222222222',
  name: 'Sponsored Search',
  slot: 'FEED_LISTING',
  billing_model: 'PER_ORDER_PREMIUM',
  price_npr: 15,
  duration_days: 30,
  active_purchase_count: 0,
};

const adForm: AdProductFormValues = {
  name: '  Home Page Carousel ',
  slot: 'CAROUSEL',
  billingModel: 'FLAT_RATE',
  price: '7500.50',
  durationDays: '14',
  isActive: true,
};

const settings: LogisticsSettingsView = {
  self_delivery_enabled: true,
  platform_fleet_enabled: true,
  platform_delivery_fee_npr: 50,
  free_delivery_above_npr: null,
  self_delivery_vendor_count: 5,
  platform_fleet_vendor_count: 4,
  updated_at: '2026-10-01T06:00:00.000Z',
};

const unchanged: LogisticsSettingsWrite = {
  self_delivery_enabled: true,
  platform_fleet_enabled: true,
  platform_delivery_fee_npr: 50,
  free_delivery_above_npr: null,
};

const clean: ModelChangeRequestView = {
  id: '33333333-3333-4333-8333-333333333333',
  vendor_id: '44444444-4444-4444-8444-444444444444',
  business_name: 'Kirtipur Kirana Pasal',
  phone: '+9779800000020',
  current_model: 'COD_CREDIT',
  from_model: 'COD_CREDIT',
  requested_model: 'PLATFORM_ESCROW',
  status: 'PENDING',
  requested_at: '2026-10-03T05:30:00.000Z',
  open_order_count: 0,
  ledger_balance_npr: 0,
  active_ad_count: 0,
  decided_at: null,
  rejection_reason: null,
};

const blocked: ModelChangeRequestView = {
  ...clean,
  id: '55555555-5555-4555-8555-555555555555',
  business_name: 'Bhaktapur Durbar Sweets',
  requested_at: '2026-10-05T09:10:00.000Z',
  open_order_count: 2,
  ledger_balance_npr: -450,
};

const decided: ModelChangeRequestView = {
  ...clean,
  id: '66666666-6666-4666-8666-666666666666',
  current_model: 'PLATFORM_ESCROW',
  status: 'APPROVED',
  decided_at: '2026-09-26T04:20:00.000Z',
};

describe('tabs', () => {
  it('opens the three sections by their hash and labels the last one Vendor requests', () => {
    expect(tabFromHash('#/ad-products')).toBe('ad-products');
    expect(tabFromHash('#/logistics')).toBe('logistics');
    expect(tabFromHash('#/approvals')).toBe('approvals');
    expect(TABS.find((tab) => tab.id === 'approvals')?.label).toBe('Vendor requests');
  });
});

describe('ad product contract', () => {
  const request = {
    name: 'Home Page Carousel',
    slot: 'CAROUSEL',
    billing_model: 'FLAT_RATE',
    price_npr: 5000,
    duration_days: 7,
    is_active: true,
  } as const;
  const accepts = (body: unknown) => adProductCreateRequestSchema.safeParse(body).success;

  it('accepts a product of each placement, and no other placement', () => {
    expect(adProductViewSchema.safeParse(carousel).success).toBe(true);
    expect(adProductViewSchema.safeParse(search).success).toBe(true);
    expect(adProductViewSchema.safeParse({ ...carousel, slot: 'FEATURED' }).success).toBe(false);
    expect(accepts({ ...request, slot: 'FEATURED' })).toBe(false);
  });

  it('takes a positive NPR price in whole paisa and 1 to 90 days', () => {
    expect(accepts(request)).toBe(true);
    expect(accepts({ ...request, billing_model: 'PER_ORDER_PREMIUM', price_npr: 15 })).toBe(true);
    expect(accepts({ ...request, price_npr: 0 })).toBe(false);
    expect(accepts({ ...request, price_npr: 10.005 })).toBe(false);
    expect(accepts({ ...request, duration_days: 0 })).toBe(false);
    expect(accepts({ ...request, duration_days: 91 })).toBe(false);
    expect(accepts({ ...request, duration_days: 7.5 })).toBe(false);
    expect(accepts({ ...request, slot: 'SEARCH' })).toBe(false);
  });

  it('has no way to name a vendor or book an ad', () => {
    for (const extra of [
      { vendor_id: carousel.id },
      { vendor_ids: [] },
      { ad_purchase_id: carousel.id },
    ]) {
      expect(accepts({ ...request, ...extra })).toBe(false);
    }
  });

  it('has no way to change the terms of an existing product', () => {
    const update = { name: 'Carousel', is_active: false };
    expect(adProductUpdateRequestSchema.safeParse(update).success).toBe(true);
    for (const extra of [
      { price_npr: 1 },
      { billing_model: 'FLAT_RATE' },
      { slot: 'CAROUSEL' },
      { duration_days: 7 },
    ]) {
      expect(adProductUpdateRequestSchema.safeParse({ ...update, ...extra }).success).toBe(false);
    }
  });

  it('offers the carousel and Sponsored Search, which is the feed listing slot', () => {
    expect(AD_SLOTS_ON_SALE).toEqual(['CAROUSEL', 'FEED_LISTING']);
    expect(AD_SLOT_LABELS.FEED_LISTING).toBe('Sponsored Search');
  });
});

describe('ad product form', () => {
  it('starts as a 7-day flat-rate carousel product on sale', () => {
    expect(emptyAdProductForm()).toEqual({
      name: '',
      slot: 'CAROUSEL',
      billingModel: 'FLAT_RATE',
      price: '',
      durationDays: '7',
      isActive: true,
    });
  });

  it('builds the create request', () => {
    expect(validateNewAdProduct(adForm)).toEqual({
      ok: true,
      request: {
        name: 'Home Page Carousel',
        slot: 'CAROUSEL',
        billing_model: 'FLAT_RATE',
        price_npr: 7500.5,
        duration_days: 14,
        is_active: true,
      },
    });
  });

  it('names each refused field', () => {
    expect(validateNewAdProduct({ ...adForm, name: ' ', price: '10%', durationDays: '0' })).toEqual(
      {
        ok: false,
        errors: {
          name: 'Enter a name of at most 80 characters.',
          price: 'Enter an amount above 0, with at most two decimals.',
          durationDays: 'Enter a whole number of days, from 1 to 90.',
        },
      },
    );
    expect(validateNewAdProduct({ ...adForm, price: '0' }).ok).toBe(false);
    expect(validateNewAdProduct({ ...adForm, durationDays: '2.5' }).ok).toBe(false);
  });

  it('asks for the price in NPR under both billing models', () => {
    expect(PRICE_FIELD_LABELS.FLAT_RATE).toBe('Price for the whole period (NPR)');
    expect(PRICE_FIELD_LABELS.PER_ORDER_PREMIUM).toBe('Fee per delivered order (NPR)');
  });

  it('sends only the name and On sale for an edit, whatever the form holds', () => {
    const tampered = {
      ...formFromAdProduct(carousel),
      name: 'Carousel 7d',
      price: '1',
      isActive: false,
    };
    expect(validateAdProductEdit(tampered)).toEqual({
      ok: true,
      request: { name: 'Carousel 7d', is_active: false },
    });
    expect(validateAdProductEdit({ ...tampered, name: '' })).toEqual({
      ok: false,
      errors: { name: 'Enter a name of at most 80 characters.' },
    });
  });

  it('words the price and what going off sale does', () => {
    expect(adPriceLabel(carousel)).toBe('Rs. 5,000 for 7 days');
    expect(adPriceLabel(search)).toBe('Rs. 15 per delivered order, for 30 days');
    expect(adPriceLabel({ ...carousel, duration_days: 1 })).toBe('Rs. 5,000 for 1 day');
    expect(offSaleNote(carousel)).toBe(
      'Taking it off sale stops new purchases. The 2 running purchases continue to the end, at the price agreed.',
    );
    expect(offSaleNote({ ...carousel, active_purchase_count: 1 })).toBe(
      'Taking it off sale stops new purchases. The 1 running purchase continues to the end, at the price agreed.',
    );
    expect(offSaleNote(search)).toBeNull();
    expect(offSaleNote(null)).toBeNull();
  });
});

describe('createAdminApi (ad product endpoints)', () => {
  it('lists, creates and edits products under /api/admin/ads/products', async () => {
    const { calls, api } = fakeAdminApi((call) =>
      call.startsWith('GET')
        ? { body: { products: [carousel, search] } }
        : { body: { product: carousel } },
    );
    const create = validateNewAdProduct(adForm);
    const edit = validateAdProductEdit({
      ...formFromAdProduct(carousel),
      name: 'Carousel (old price)',
      // Whatever the locked fields hold, an edit never sends them.
      price: '1',
      isActive: false,
    });
    if (!create.ok || !edit.ok) throw new Error('form refused');

    await expect(api.listAdProducts()).resolves.toEqual({ products: [carousel, search] });
    await api.createAdProduct(create.request);
    await api.updateAdProduct(carousel.id, edit.request);

    expect(calls).toEqual([
      { call: 'GET /api/admin/ads/products', body: undefined },
      { call: 'POST /api/admin/ads/products', body: create.request },
      {
        call: `PATCH /api/admin/ads/products/${carousel.id}`,
        // Exactly the two editable fields: no slot, billing model, price or duration.
        body: { name: 'Carousel (old price)', is_active: false },
      },
    ]);
    expect(create.request).not.toHaveProperty('vendor_id');
  });

  it('refuses a list with a placement the database does not have', async () => {
    const { api } = fakeAdminApi(() => ({
      body: { products: [{ ...carousel, slot: 'FEATURED' }] },
    }));
    await expect(api.listAdProducts()).rejects.toMatchObject({ code: 'UNEXPECTED_RESPONSE' });
  });

  it("passes the server's refusal on and words it", async () => {
    const { api } = fakeAdminApi(() => refusalOf(400, 'VALIDATION_FAILED'));
    const error: unknown = await api
      .updateAdProduct(carousel.id, { name: 'x', is_active: true })
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ status: 400, code: 'VALIDATION_FAILED' });
    expect(adProductSaveErrorMessage(error)).toBe(
      'The server refused this ad product. Check the fields.',
    );
    expect(adProductSaveErrorMessage(new ApiError(404, 'AD_PRODUCT_NOT_FOUND', 'x'))).toBe(
      'This ad product no longer exists. Close and refresh the list.',
    );
    expect(adProductSaveErrorMessage(new Error('boom'))).toBe(
      'The ad product could not be saved. Try again.',
    );
  });
});

describe('ad product rows', () => {
  it('lists products on sale first, then by placement and name', () => {
    const retired = { ...search, id: STAMP.id, is_active: false, price_npr: 10 };
    expect(adProductRows([retired, search, carousel]).map((product) => product.id)).toEqual([
      carousel.id,
      search.id,
      retired.id,
    ]);
  });
});

describe('logistics contract', () => {
  it('accepts the settings as the server answers them', () => {
    expect(logisticsSettingsViewSchema.safeParse(settings).success).toBe(true);
  });

  it('takes a fee from 0 to 10000 in whole paisa', () => {
    const withFee = (fee: number) =>
      logisticsSettingsWriteSchema.safeParse({ ...unchanged, platform_delivery_fee_npr: fee })
        .success;
    expect(withFee(0)).toBe(true);
    expect(withFee(49.5)).toBe(true);
    expect(withFee(10_000)).toBe(true);
    expect(withFee(-1)).toBe(false);
    expect(withFee(10_000.01)).toBe(false);
    expect(withFee(1.005)).toBe(false);
  });

  it('allows either mode off, and both: the emergency stop', () => {
    for (const [self, fleet] of [
      [false, true],
      [true, false],
      [false, false],
    ] as const) {
      expect(
        logisticsSettingsWriteSchema.safeParse({
          ...unchanged,
          self_delivery_enabled: self,
          platform_fleet_enabled: fleet,
        }).success,
      ).toBe(true);
    }
  });

  it('refuses unknown settings', () => {
    expect(
      logisticsSettingsWriteSchema.safeParse({ ...unchanged, platform_delivery_enabled: true })
        .success,
    ).toBe(false);
  });
});

describe('logistics panel', () => {
  it('round-trips the settings through the form unchanged', () => {
    const result = validateLogisticsForm(formFromLogistics(settings));
    expect(result).toEqual({ ok: true, request: unchanged });
    if (result.ok) expect(logisticsChanged(settings, result.request)).toBe(false);
  });

  it('builds the request from the toggles and the typed fee', () => {
    expect(
      validateLogisticsForm({
        selfDeliveryEnabled: false,
        platformFleetEnabled: true,
        platformDeliveryFee: ' 75.50 ',
        freeDeliveryAbove: '',
      }),
    ).toEqual({
      ok: true,
      request: {
        self_delivery_enabled: false,
        platform_fleet_enabled: true,
        platform_delivery_fee_npr: 75.5,
        free_delivery_above_npr: null,
      },
    });
  });

  it('refuses a malformed fee and nothing else', () => {
    expect(
      validateLogisticsForm({ ...formFromLogistics(settings), platformDeliveryFee: 'fifty' }),
    ).toEqual({
      ok: false,
      errors: {
        platformDeliveryFee: 'Enter an amount from 0 to Rs. 10,000, with at most two decimals.',
      },
    });
    expect(
      validateLogisticsForm({
        selfDeliveryEnabled: false,
        platformFleetEnabled: false,
        platformDeliveryFee: '50',
        freeDeliveryAbove: '',
      }).ok,
    ).toBe(true);
  });

  it('asks for confirmation before the emergency stop, whatever the shop counts', () => {
    const stop = { ...unchanged, self_delivery_enabled: false, platform_fleet_enabled: false };
    expect(isEmergencyStop(stop)).toBe(true);
    expect(isEmergencyStop(unchanged)).toBe(false);
    expect(modeDisableWarning(settings, stop)).toBe(EMERGENCY_STOP_WARNING);
    expect(
      modeDisableWarning(
        { ...settings, self_delivery_vendor_count: 0, platform_fleet_vendor_count: 0 },
        stop,
      ),
    ).toBe(EMERGENCY_STOP_WARNING);
    // Already stopped: a fee change during the stop needs no second confirmation.
    expect(
      modeDisableWarning(
        { ...settings, self_delivery_enabled: false, platform_fleet_enabled: false },
        { ...stop, platform_delivery_fee_npr: 80 },
      ),
    ).toBeNull();
  });

  it('warns how many shops stop taking orders when their mode is switched off', () => {
    expect(modeDisableWarning(settings, { ...unchanged, platform_fleet_enabled: false })).toBe(
      '4 shops on the platform fleet will stop taking orders until each one chooses an enabled mode in the Vendor App. Orders already placed are delivered as placed.',
    );
    expect(
      modeDisableWarning(
        { ...settings, self_delivery_vendor_count: 1 },
        { ...unchanged, self_delivery_enabled: false },
      ),
    ).toBe(
      '1 shop on self delivery will stop taking orders until each one chooses an enabled mode in the Vendor App. Orders already placed are delivered as placed.',
    );
  });

  it('does not warn for a mode nobody uses, a mode switched on or a fee change', () => {
    expect(
      modeDisableWarning(
        { ...settings, platform_fleet_vendor_count: 0 },
        { ...unchanged, platform_fleet_enabled: false },
      ),
    ).toBeNull();
    expect(
      modeDisableWarning({ ...settings, platform_fleet_enabled: false }, unchanged),
    ).toBeNull();
    expect(
      modeDisableWarning(settings, { ...unchanged, platform_delivery_fee_npr: 80 }),
    ).toBeNull();
  });

  it('says what a changed fee applies to', () => {
    expect(feeChangeNote(settings, { ...unchanged, platform_delivery_fee_npr: 80 })).toBe(
      'Platform fleet orders placed from now on are charged Rs. 80 (was Rs. 50). Orders already placed keep their fee.',
    );
    expect(feeChangeNote(settings, unchanged)).toBeNull();
  });

  it('reads the platform free-delivery threshold: empty is off, else an amount above 0', () => {
    const form = formFromLogistics({ ...settings, free_delivery_above_npr: 100 });
    expect(form.freeDeliveryAbove).toBe('100');
    expect(validateLogisticsForm(form)).toMatchObject({
      ok: true,
      request: { free_delivery_above_npr: 100 },
    });
    expect(validateLogisticsForm({ ...form, freeDeliveryAbove: ' ' })).toMatchObject({
      ok: true,
      request: { free_delivery_above_npr: null },
    });
    for (const bad of ['0', 'abc', '10.005', '100001']) {
      const result = validateLogisticsForm({ ...form, freeDeliveryAbove: bad });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(Object.keys(result.errors)).toEqual(['freeDeliveryAbove']);
    }
    const on = { ...unchanged, free_delivery_above_npr: 100 };
    expect(logisticsChanged(settings, on)).toBe(true);
    expect(freeDeliveryChangeNote(settings, on)).toContain('Hamro Pasal pays the delivery fee');
    expect(
      freeDeliveryChangeNote({ ...settings, free_delivery_above_npr: 100 }, unchanged),
    ).toContain('stops');
    expect(freeDeliveryChangeNote(settings, unchanged)).toBeNull();
  });

  it('explains a save that failed', () => {
    expect(logisticsErrorMessage(new ApiError(400, 'VALIDATION_FAILED', 'x'))).toBe(
      'The server refused these settings. Check the delivery charge and try again.',
    );
    expect(logisticsErrorMessage(new ApiError(0, 'NETWORK_ERROR', 'x'))).toBe(
      'The API cannot be reached. Try again.',
    );
    expect(logisticsErrorMessage(new Error('boom'))).toBe(
      'The settings could not be saved. Try again.',
    );
  });
});

describe('createAdminApi (logistics endpoints)', () => {
  it('reads the settings and sends exactly the three writable ones', async () => {
    const calls: { call: string; body: unknown }[] = [];
    const stop = { ...unchanged, self_delivery_enabled: false, platform_fleet_enabled: false };
    const fetch: FetchLike = (url, init) => {
      calls.push({
        call: `${init.method ?? ''} ${url}`,
        body: typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : init.body,
      });
      const body =
        init.method === 'PUT' ? { ...settings, ...stop, updated_at: STAMP.now } : settings;
      return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
    };
    const session = createSessionStore();
    session.getState().setSession({
      phone: '+9779800000099',
      user: { id: STAMP.id, role: 'SUPER_ADMIN', first_name: null },
      accessToken: 'access-1',
    });
    const api = createAdminApi(createApiClient({ baseUrl: '', fetch, session }));

    await expect(api.getLogisticsSettings()).resolves.toEqual(settings);
    // Both modes off (the Emergency Stop) is a body like any other: the screen asks twice, not the client.
    await expect(api.updateLogisticsSettings(stop)).resolves.toEqual({
      ...settings,
      ...stop,
      updated_at: STAMP.now,
    });

    expect(calls).toEqual([
      { call: 'GET /api/admin/settings/logistics', body: undefined },
      { call: 'PUT /api/admin/settings/logistics', body: stop },
    ]);
  });
});

describe('settlement model change contract', () => {
  it('accepts a pending, a blocked and a decided request', () => {
    for (const request of [clean, blocked, decided]) {
      expect(modelChangeRequestViewSchema.safeParse(request).success).toBe(true);
    }
  });

  it('refuses a request for the same model and a decision state that does not add up', () => {
    const accepts = (request: unknown) => modelChangeRequestViewSchema.safeParse(request).success;
    expect(accepts(clean)).toBe(true);
    expect(accepts({ ...clean, requested_model: 'COD_CREDIT' })).toBe(false);
    expect(accepts({ ...clean, decided_at: STAMP.now })).toBe(false);
    expect(accepts({ ...decided, decided_at: null })).toBe(false);
    expect(accepts({ ...decided, rejection_reason: 'No' })).toBe(false);
  });
});

describe('createAdminApi (settlement model request endpoints)', () => {
  const approved = {
    ...clean,
    status: 'APPROVED',
    current_model: 'PLATFORM_ESCROW',
    decided_at: STAMP.now,
  } as const;

  it('lists the requests and sends a decision that names no model', async () => {
    const { calls, api } = fakeAdminApi((call) =>
      call.startsWith('GET')
        ? { body: { requests: [clean, blocked, decided] } }
        : { body: { request: approved } },
    );

    await expect(api.listModelChangeRequests()).resolves.toEqual({
      requests: [clean, blocked, decided],
    });
    await expect(api.approveModelChangeRequest(clean.id)).resolves.toEqual({ request: approved });
    await api.rejectModelChangeRequest(blocked.id, 'Clear your dues first.');
    await api.rejectModelChangeRequest(blocked.id, null);

    expect(calls).toEqual([
      { call: 'GET /api/admin/settlement-model-requests', body: undefined },
      // No body at all: the shop gets the model it asked for.
      { call: `POST /api/admin/settlement-model-requests/${clean.id}/approve`, body: undefined },
      {
        call: `POST /api/admin/settlement-model-requests/${blocked.id}/reject`,
        body: { reason: 'Clear your dues first.' },
      },
      {
        call: `POST /api/admin/settlement-model-requests/${blocked.id}/reject`,
        body: { reason: null },
      },
    ]);
    expect(Object.keys(api).filter((name) => name.includes('ModelChange'))).toEqual([
      'listModelChangeRequests',
      'approveModelChangeRequest',
      'rejectModelChangeRequest',
    ]);
  });

  it('puts the answered request in place of its row', () => {
    expect(replaceModelChangeRequest({ requests: [clean, blocked] }, approved)).toEqual({
      requests: [approved, blocked],
    });
  });

  it('names the guardrails the server found after the list was loaded', async () => {
    const { api } = fakeAdminApi(() =>
      refusalOf(409, 'SETTLEMENT_CHANGE_BLOCKED', { blockers: ['OPEN_ORDERS', 'ACTIVE_AD'] }),
    );
    const error: unknown = await api
      .approveModelChangeRequest(clean.id)
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ status: 409, code: 'SETTLEMENT_CHANGE_BLOCKED' });
    expect(decisionErrorMessage(error)).toBe(
      'The shop now has open orders, an ad running: the change cannot take effect yet. The list has been refreshed.',
    );
    expect(decisionErrorMessage(new ApiError(409, 'SETTLEMENT_CHANGE_BLOCKED', 'x'))).toBe(
      'The change cannot take effect yet. The list has been refreshed.',
    );
  });

  it('words the other refusals', () => {
    expect(decisionErrorMessage(new ApiError(422, 'SETTLEMENT_MODEL_UNAVAILABLE', 'x'))).toBe(
      'Model C (direct prepaid) cannot be selected before Phase 3. Reject the request.',
    );
    expect(decisionErrorMessage(new ApiError(409, 'REQUEST_ALREADY_DECIDED', 'x'))).toBe(
      'This request has already been decided. The list has been refreshed.',
    );
    expect(decisionErrorMessage(new ApiError(404, 'SETTLEMENT_MODEL_REQUEST_NOT_FOUND', 'x'))).toBe(
      'This request no longer exists.',
    );
    expect(decisionErrorMessage(new ApiError(0, 'NETWORK_ERROR', 'x'))).toBe(
      'The API cannot be reached. Try again.',
    );
    expect(decisionErrorMessage(new Error('boom'))).toBe(
      'The decision could not be saved. Try again.',
    );
  });
});

describe('approving a settlement model change', () => {
  it('names the three models', () => {
    expect(SETTLEMENT_MODEL_LABELS).toEqual({
      COD_CREDIT: 'Model A · COD credit',
      PLATFORM_ESCROW: 'Model B · Platform escrow',
      DIRECT_PREPAID: 'Model C · Direct prepaid',
    });
  });

  it('allows a shop with no open order, no ad and a ledger at 0', () => {
    expect(blockersOf(clean)).toEqual([]);
    expect(approveButton(clean)).toEqual({
      enabled: true,
      note: 'Applies to new orders at once. Orders already placed settle under the model they were placed with.',
    });
    expect(approveButton({ ...clean, ledger_balance_npr: 0.01 }).enabled).toBe(true);
  });

  it('blocks on open orders, a negative ledger and a running ad, naming each', () => {
    expect(blockersOf(blocked)).toEqual(['OPEN_ORDERS', 'NEGATIVE_BALANCE']);
    expect(approveButton(blocked)).toEqual({
      enabled: false,
      note: 'Cannot take effect yet: 2 open orders; ledger at Rs. -450 (must be 0 or above).',
    });
    expect(approveButton({ ...clean, ledger_balance_npr: -0.01 }).enabled).toBe(false);
    expect(approveButton({ ...clean, active_ad_count: 1 })).toEqual({
      enabled: false,
      note: 'Cannot take effect yet: 1 ad running.',
    });
    expect(approveButton({ ...clean, open_order_count: 1 }).note).toBe(
      'Cannot take effect yet: 1 open order.',
    );
  });

  it('approves a move to Model C only with the prepaid balance at the Fixed Reserve (2026-10-21)', () => {
    const toPrepaid = { ...clean, requested_model: 'DIRECT_PREPAID' as const };
    expect(approveButton({ ...toPrepaid, ledger_balance_npr: 4999.99 })).toEqual({
      enabled: false,
      note: 'Cannot take effect yet: prepaid balance at Rs. 4,999.99 (Model C needs the Fixed Reserve first).',
    });
    expect(validateDecision({ ...toPrepaid, ledger_balance_npr: 0 }, 'APPROVE', '').ok).toBe(false);
    expect(validateDecision(toPrepaid, 'REJECT', '').ok).toBe(true);
    const funded = { ...toPrepaid, ledger_balance_npr: 5000 };
    expect(approveButton(funded).enabled).toBe(true);
    expect(validateDecision(funded, 'APPROVE', '').ok).toBe(true);
  });

  it('sends an approval with no reason, whatever was typed', () => {
    expect(validateDecision(clean, 'APPROVE', 'ignored for an approval')).toEqual({
      ok: true,
      reason: null,
    });
  });

  it('sends a rejection with the trimmed reason or none', () => {
    expect(validateDecision(blocked, 'REJECT', '  Clear your dues first. ')).toEqual({
      ok: true,
      reason: 'Clear your dues first.',
    });
    expect(validateDecision(blocked, 'REJECT', '   ')).toEqual({ ok: true, reason: null });
    expect(validateDecision(blocked, 'REJECT', 'x'.repeat(501))).toEqual({
      ok: false,
      error: 'Enter a reason of at most 500 characters, or leave it empty.',
    });
  });

  it('refuses to approve a blocked request before anything is sent', () => {
    expect(validateDecision(blocked, 'APPROVE', '')).toEqual({
      ok: false,
      error: 'Cannot take effect yet: 2 open orders; ledger at Rs. -450 (must be 0 or above).',
    });
  });

  it('decides a request once', () => {
    expect(validateDecision(decided, 'REJECT', '')).toEqual({
      ok: false,
      error: 'This request has already been decided.',
    });
  });

  it('opens on the pending requests, the longest waiting first', () => {
    expect(MODEL_CHANGE_FILTERS[0]).toEqual({ label: 'Pending', pending: true });
    expect(modelChangeRows([blocked, decided, clean], true).map((request) => request.id)).toEqual([
      clean.id,
      blocked.id,
    ]);
    const later = { ...decided, id: STAMP.id, decided_at: '2026-10-01T00:00:00.000Z' };
    expect(modelChangeRows([decided, later, clean], false).map((request) => request.id)).toEqual([
      later.id,
      decided.id,
    ]);
  });
});
