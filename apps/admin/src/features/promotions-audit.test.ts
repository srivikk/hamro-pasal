import { ApiError } from '../api/client';
import { fakeAdminApi, refusalOf } from '../api/fake-admin-api';
import * as tabs from '../tabs';
import * as auditRules from './audit/audit-rules';
import {
  actionLabel,
  actorLabel,
  auditEntriesOf,
  auditFilterOptions,
  auditLoadErrorMessage,
  auditLogQuerySchema,
  auditLogViewSchema,
  auditOptions,
  auditQueryOf,
  auditRows,
  diffSummary,
  NO_AUDIT_FILTERS,
  rawState,
  stateDiff,
  visibleDiff,
  type AuditLogView,
} from './audit/audit-rules';
import {
  adminPromotionViewSchema,
  emptyPromotionForm,
  formFromPromotion,
  promotionActionErrorMessage,
  promotionPhase,
  promotionRows,
  promotionSaveError,
  promotionWriteRequestSchema,
  SPONSORSHIP_AVAILABLE,
  targetLabel,
  validatePromotionForm,
  visibilityRequest,
  withTargetType,
  type AdminPromotionView,
  type PromotionFormValues,
} from './promotions/promotion-rules';

const STAMP = { id: '99999999-9999-4999-8999-999999999999', now: '2026-10-07T06:00:00.000Z' };
const SHOP_ID = '11111111-1111-4111-8111-111111111111';
const PURCHASE_ID = '22222222-2222-4222-8222-222222222222';

const banner: AdminPromotionView = {
  id: '33333333-3333-4333-8333-333333333333',
  placement: 'CAROUSEL',
  image_url: 'https://cdn.hamropasal.np/promotions/dashain.webp',
  title: 'Dashain Mega Sale',
  subtitle: 'Tika, sweets and gifts',
  target_type: 'CATEGORY',
  target_value: 'festive',
  display_order: 0,
  is_active: true,
  starts_at: '2026-09-30T18:15:00.000Z',
  ends_at: '2026-10-25T18:14:59.000Z',
  is_sponsored: false,
  ad_purchase_id: null,
  created_at: '2026-09-25T06:00:00.000Z',
  updated_at: '2026-09-25T06:00:00.000Z',
};

const tile: AdminPromotionView = {
  ...banner,
  id: '44444444-4444-4444-8444-444444444444',
  placement: 'FEATURED',
  image_url: null,
  title: 'Top Electronics',
  subtitle: null,
  target_value: 'electronics',
  starts_at: null,
  ends_at: null,
};

const form: PromotionFormValues = {
  placement: 'CAROUSEL',
  title: '  Dashain Mega Sale ',
  subtitle: '',
  imageUrl: ' https://cdn.hamropasal.np/promotions/dashain.webp ',
  targetType: 'CATEGORY',
  targetValue: ' festive ',
  displayOrder: '3',
  startsOn: '',
  endsOn: '',
  adPurchaseId: '',
  isActive: true,
};

const entry: AuditLogView = {
  id: '55555555-5555-4555-8555-555555555555',
  occurred_at: '2026-09-26T04:20:00.000Z',
  actor_user_id: '66666666-6666-4666-8666-666666666666',
  actor_role: 'SUPER_ADMIN',
  system_actor: null,
  actor_name: 'Sarita',
  action: 'SETTLEMENT_MODEL_CHANGED',
  vendor_id: SHOP_ID,
  vendor_name: 'Asan Masala & Snacks',
  entity_type: 'vendor_ledger',
  entity_id: SHOP_ID,
  before_state: { settlement_model: 'COD_CREDIT', balance_npr: 320 },
  after_state: { settlement_model: 'PLATFORM_ESCROW', balance_npr: 320 },
  request_id: 'req_1',
  ip_address: '103.10.28.14',
  user_agent: null,
};

const optIn: AuditLogView = {
  ...entry,
  id: '77777777-7777-4777-8777-777777777777',
  occurred_at: '2026-09-28T04:40:12.000Z',
  actor_role: 'VENDOR',
  system_actor: null,
  actor_name: 'Thamel Kirana Pasal',
  action: 'CAMPAIGN_OPTED_IN',
  vendor_name: 'Thamel Kirana Pasal',
  entity_type: 'campaign_opt_in',
  before_state: null,
  after_state: { terms_version: 2 },
};

/** Written by the nightly job: no user, no role. */
const sweep: AuditLogView = {
  ...entry,
  id: '88888888-8888-4888-8888-888888888888',
  occurred_at: '2026-10-01T18:15:00.000Z',
  actor_user_id: null,
  actor_role: null,
  system_actor: 'VENDOR_COMPLIANCE_SWEEP',
  actor_name: 'VENDOR_COMPLIANCE_SWEEP',
  action: 'VENDOR_SUSPENDED_FOR_COMPLIANCE',
  entity_type: 'vendor',
  before_state: { status: 'LIVE' },
  after_state: { status: 'SUSPENDED_COMPLIANCE' },
  request_id: null,
  ip_address: null,
};

describe('tabs', () => {
  it('opens Promotions and the Audit log, and leaves no placeholder section', () => {
    expect(tabs.tabFromHash('#/promotions')).toBe('promotions');
    expect(tabs.tabFromHash('#/audit-log')).toBe('audit-log');
    expect(tabs.TABS).toHaveLength(14);
    expect(Object.keys(tabs)).not.toContain('PLANNED_SECTIONS');
  });
});

describe('promotion contract', () => {
  const request = visibilityRequest(banner, true);
  const accepts = (body: unknown) => promotionWriteRequestSchema.safeParse(body).success;

  it('accepts a banner and a tile, as a view and as a write', () => {
    for (const promotion of [banner, tile]) {
      expect(adminPromotionViewSchema.safeParse(promotion).success).toBe(true);
      expect(accepts(visibilityRequest(promotion, promotion.is_active))).toBe(true);
    }
  });

  it('needs an image for a carousel banner and a title for a featured offer', () => {
    expect(accepts(request)).toBe(true);
    expect(accepts({ ...request, title: null })).toBe(true);
    expect(accepts({ ...request, image_url: null })).toBe(false);
    expect(accepts({ ...request, image_url: 'ftp://cdn/x.png' })).toBe(false);
    const featured = { ...request, placement: 'FEATURED' };
    expect(accepts({ ...featured, image_url: null })).toBe(true);
    expect(accepts({ ...featured, title: null })).toBe(false);
  });

  it('fits the target value to its type', () => {
    const target = (type: string | null, value: string | null) =>
      accepts({ ...request, target_type: type, target_value: value });
    expect(target('SHOP', SHOP_ID)).toBe(true);
    expect(target('SHOP', 'thamel-kirana')).toBe(false);
    expect(target('CATEGORY', 'festive')).toBe(true);
    expect(target('CATEGORY', 'rice-flour-pulses')).toBe(true);
    expect(target('CATEGORY', 'Festive & Dashain')).toBe(false);
    expect(target('CATEGORY', 'Rice_Flour')).toBe(false);
    expect(target('DISCOUNT_TAG', '10% OFF')).toBe(true);
    expect(target('DISCOUNT_TAG', 'x'.repeat(41))).toBe(false);
    expect(target('DISCOUNT_TAG', '   ')).toBe(false);
    expect(target('PRODUCT', SHOP_ID)).toBe(false);
  });

  it('has a target type and a value together, or neither', () => {
    expect(accepts({ ...request, target_type: null, target_value: null })).toBe(true);
    expect(accepts({ ...request, target_type: null, target_value: 'festive' })).toBe(false);
    expect(accepts({ ...request, target_type: 'CATEGORY', target_value: null })).toBe(false);
  });

  it('refuses a sponsored promotion without the ad purchase, and the reverse', () => {
    const shop = { ...request, target_type: 'SHOP', target_value: SHOP_ID };
    expect(accepts({ ...shop, is_sponsored: true, ad_purchase_id: PURCHASE_ID })).toBe(true);
    expect(accepts({ ...shop, is_sponsored: true, ad_purchase_id: null })).toBe(false);
    expect(accepts({ ...shop, is_sponsored: false, ad_purchase_id: PURCHASE_ID })).toBe(false);
    // A sponsored promotion points at the shop that bought it.
    expect(accepts({ ...request, is_sponsored: true, ad_purchase_id: PURCHASE_ID })).toBe(false);
  });

  it('has no price, discount or vendor-charge key, and orders from 0', () => {
    for (const extra of [{ discount_percent: 10 }, { price_npr: 100 }, { sort_order: 1 }]) {
      expect(accepts({ ...request, ...extra })).toBe(false);
    }
    expect(accepts({ ...request, display_order: -1 })).toBe(false);
    expect(accepts({ ...request, display_order: 1.5 })).toBe(false);
    expect(accepts({ ...request, ends_at: request.starts_at })).toBe(false);
  });
});

describe('promotion form', () => {
  it('starts as an active carousel banner aimed at a shop', () => {
    expect(emptyPromotionForm()).toMatchObject({
      placement: 'CAROUSEL',
      targetType: 'SHOP',
      displayOrder: '0',
      isActive: true,
    });
  });

  it('builds the request: trimmed, blanks as null, no dates, not sponsored', () => {
    expect(validatePromotionForm(form)).toEqual({
      ok: true,
      request: {
        placement: 'CAROUSEL',
        image_url: 'https://cdn.hamropasal.np/promotions/dashain.webp',
        title: 'Dashain Mega Sale',
        subtitle: null,
        target_type: 'CATEGORY',
        target_value: 'festive',
        display_order: 3,
        is_active: true,
        starts_at: null,
        ends_at: null,
        is_sponsored: false,
        ad_purchase_id: null,
      },
    });
  });

  it('sends the days as whole Nepal Time days and an untappable promotion with no target', () => {
    const result = validatePromotionForm({
      ...form,
      targetType: '',
      targetValue: 'left over',
      startsOn: '2026-10-01',
      endsOn: '2026-10-01',
    });
    expect(result).toMatchObject({
      ok: true,
      request: {
        target_type: null,
        target_value: null,
        starts_at: '2026-09-30T18:15:00.000Z',
        ends_at: '2026-10-01T18:14:59.000Z',
      },
    });
  });

  it('marks a promotion sponsored exactly when an ad purchase is named', () => {
    expect(
      validatePromotionForm({
        ...form,
        targetType: 'SHOP',
        targetValue: SHOP_ID,
        adPurchaseId: ` ${PURCHASE_ID} `,
      }),
    ).toMatchObject({ ok: true, request: { is_sponsored: true, ad_purchase_id: PURCHASE_ID } });
    expect(validatePromotionForm({ ...form, adPurchaseId: PURCHASE_ID })).toEqual({
      ok: false,
      errors: { targetValue: 'A sponsored promotion must target the shop that bought it.' },
    });
    expect(
      validatePromotionForm({
        ...form,
        targetType: 'SHOP',
        targetValue: SHOP_ID,
        adPurchaseId: 'purchase-7',
      }),
    ).toEqual({
      ok: false,
      errors: { adPurchaseId: 'Enter the ad purchase id (a UUID), or leave it empty.' },
    });
  });

  it('words the target error by the target type', () => {
    const targetError = (targetType: PromotionFormValues['targetType'], targetValue: string) => {
      const result = validatePromotionForm({ ...form, targetType, targetValue });
      return result.ok ? null : result.errors.targetValue;
    };
    expect(targetError('SHOP', 'thamel')).toBe('Enter the shop’s id (a UUID).');
    expect(targetError('CATEGORY', 'Festive Sale')).toBe(
      'Enter a category slug: lower-case words joined by hyphens.',
    );
    expect(targetError('DISCOUNT_TAG', '')).toBe('Enter an offer label of at most 40 characters.');
    expect(targetError('DISCOUNT_TAG', '10% OFF')).toBeNull();
  });

  it('names the missing image, the missing title and a bad order or day', () => {
    expect(
      validatePromotionForm({ ...form, imageUrl: '', displayOrder: '1.5', endsOn: '2026-02-30' }),
    ).toEqual({
      ok: false,
      errors: {
        displayOrder: 'Enter a whole number from 0 to 100000.',
        endsOn: 'Choose a day on or after the first day, or leave it empty.',
      },
    });
    expect(validatePromotionForm({ ...form, imageUrl: '' })).toEqual({
      ok: false,
      errors: { imageUrl: 'A carousel banner needs its image.' },
    });
    expect(validatePromotionForm({ ...form, imageUrl: 'dashain.webp' })).toEqual({
      ok: false,
      errors: { imageUrl: 'Enter a full http(s) address.' },
    });
    expect(
      validatePromotionForm({ ...form, placement: 'FEATURED', title: ' ', imageUrl: '' }),
    ).toEqual({ ok: false, errors: { title: 'A featured offer needs a title.' } });
    expect(
      validatePromotionForm({ ...form, startsOn: '2026-10-10', endsOn: '2026-10-09' }),
    ).toEqual({
      ok: false,
      errors: { endsOn: 'Choose a day on or after the first day, or leave it empty.' },
    });
  });

  it('empties the target value when the target type changes', () => {
    expect(withTargetType(form, 'SHOP')).toEqual({ ...form, targetType: 'SHOP', targetValue: '' });
    expect(withTargetType(form, 'CATEGORY')).toBe(form);
  });

  it('round-trips a promotion through the form unchanged', () => {
    for (const promotion of [banner, tile]) {
      expect(validatePromotionForm(formFromPromotion(promotion))).toEqual({
        ok: true,
        request: visibilityRequest(promotion, promotion.is_active),
      });
    }
  });
});

describe('createAdminApi (promotion endpoints)', () => {
  it('lists, creates, replaces and deletes promotions under /api/admin/promotions', async () => {
    const { calls, api } = fakeAdminApi((call) =>
      call.startsWith('GET')
        ? { body: { promotions: [banner, tile] } }
        : call.startsWith('DELETE')
          ? {}
          : { body: { promotion: banner } },
    );
    const result = validatePromotionForm(form);
    if (!result.ok) throw new Error('form refused');
    const hidden = visibilityRequest(banner, false);

    await expect(api.listPromotions()).resolves.toEqual({ promotions: [banner, tile] });
    await api.createPromotion(result.request);
    await api.updatePromotion(banner.id, hidden);
    await expect(api.deletePromotion(tile.id)).resolves.toBeUndefined();

    expect(calls).toEqual([
      { call: 'GET /api/admin/promotions', body: undefined },
      { call: 'POST /api/admin/promotions', body: result.request },
      // PUT replaces the row: hiding sends every field, with is_active flipped.
      { call: `PUT /api/admin/promotions/${banner.id}`, body: { ...hidden, is_active: false } },
      { call: `DELETE /api/admin/promotions/${tile.id}`, body: undefined },
    ]);
  });

  it('offers no sponsorship: every promotion the form builds is an ordinary one', () => {
    expect(SPONSORSHIP_AVAILABLE).toBe(false);
    // The form is never shown a purchase field, so the value stays empty.
    for (const values of [emptyPromotionForm(), form, formFromPromotion(banner)]) {
      expect(values.adPurchaseId).toBe('');
    }
    const result = validatePromotionForm(form);
    expect(result).toMatchObject({
      ok: true,
      request: { is_sponsored: false, ad_purchase_id: null },
    });
  });

  it('puts an unknown target on the target field, worded by its type', async () => {
    const { api } = fakeAdminApi(() =>
      refusalOf(422, 'PROMOTION_TARGET_NOT_FOUND', { target_type: 'CATEGORY' }),
    );
    const error: unknown = await api
      .updatePromotion(banner.id, visibilityRequest(banner, true))
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ status: 422, code: 'PROMOTION_TARGET_NOT_FOUND' });
    expect(promotionSaveError(error, 'CATEGORY')).toEqual({
      field: 'targetValue',
      message: 'No active category has this slug (its parent categories must be active too).',
    });
    expect(promotionSaveError(error, 'SHOP')).toEqual({
      field: 'targetValue',
      message: 'No LIVE shop has this id.',
    });
  });

  it('explains the other refusals on the form', () => {
    for (const code of ['AD_PURCHASE_MISMATCH', 'AD_PURCHASE_REQUIRED']) {
      expect(promotionSaveError(new ApiError(422, code, 'x'), 'SHOP')).toEqual({
        field: null,
        message: 'Sponsored promotions are not available yet: no vendor can buy an ad.',
      });
    }
    expect(promotionSaveError(new ApiError(404, 'PROMOTION_NOT_FOUND', 'x'), '').field).toBeNull();
    expect(promotionSaveError(new ApiError(0, 'NETWORK_ERROR', 'x'), '').message).toBe(
      'The API cannot be reached. Try again.',
    );
    expect(promotionSaveError(new Error('boom'), '')).toEqual({
      field: null,
      message: 'The promotion could not be saved. Try again.',
    });
  });

  it('says so when a row was deleted by someone else first', async () => {
    const { api } = fakeAdminApi(() => refusalOf(404, 'PROMOTION_NOT_FOUND'));
    const error: unknown = await api.deletePromotion(tile.id).catch((caught: unknown) => caught);
    expect(promotionActionErrorMessage(error)).toBe(
      'That promotion no longer exists. The list has been refreshed.',
    );
  });
});

describe('promotion display', () => {
  const NOW = '2026-10-07T06:00:00.000Z';

  it('tells hidden, scheduled, live and ended apart', () => {
    expect(promotionPhase(banner, NOW)).toBe('LIVE');
    expect(promotionPhase(banner, '2026-09-29T00:00:00.000Z')).toBe('SCHEDULED');
    expect(promotionPhase({ ...banner, is_active: false }, NOW)).toBe('HIDDEN');
    // Its last instant has passed: ended, whether or not it is still switched on.
    expect(promotionPhase(banner, banner.ends_at ?? '')).toBe('ENDED');
    expect(promotionPhase({ ...banner, is_active: false }, '2026-11-01T00:00:00.000Z')).toBe(
      'ENDED',
    );
    // No dates: live from now until switched off.
    expect(promotionPhase(tile, NOW)).toBe('LIVE');
  });

  it('names the target, or says the promotion is not tappable', () => {
    expect(targetLabel(banner)).toBe('Category · festive');
    expect(targetLabel({ target_type: 'SHOP', target_value: SHOP_ID })).toBe(`Shop · ${SHOP_ID}`);
    expect(targetLabel({ target_type: null, target_value: null })).toBe('Not tappable');
  });

  it('lists the carousel before the featured offers, a lower order first, then the older', () => {
    const second = { ...banner, id: STAMP.id, display_order: 1 };
    const newer = { ...banner, id: PURCHASE_ID, created_at: STAMP.now };
    expect(promotionRows([tile, second, newer, banner]).map((row) => row.id)).toEqual([
      banner.id,
      newer.id,
      second.id,
      tile.id,
    ]);
  });
});

describe('audit log contract', () => {
  it("accepts a user's entry, a creation and a job's entry", () => {
    for (const sample of [entry, optIn, sweep]) {
      expect(auditLogViewSchema.safeParse(sample).success).toBe(true);
    }
  });

  it('is read only: the module exports no write schema or store', () => {
    const exported = Object.keys(auditRules);
    expect(
      exported.filter((name) => /write|create|update|delete|apply|request/i.test(name)),
    ).toEqual([]);
    expect(exported.filter((name) => name.endsWith('Schema')).sort()).toEqual([
      'auditLogQuerySchema',
      'auditLogViewSchema',
    ]);
  });

  it('takes a creation with no state before, and always a state after', () => {
    expect(auditLogViewSchema.safeParse(optIn).success).toBe(true);
    expect(auditLogViewSchema.safeParse({ ...entry, after_state: null }).success).toBe(false);
    expect(auditLogViewSchema.safeParse({ ...entry, action: 'plan edited' }).success).toBe(false);
    expect(auditLogViewSchema.safeParse({ ...entry, actor_role: 'SYSTEM' }).success).toBe(false);
    // A job's entry names the job in place of a user and a role.
    expect(
      auditLogViewSchema.safeParse({
        ...entry,
        actor_user_id: null,
        actor_role: null,
        system_actor: 'BILLING_CYCLE_RENEWAL',
        actor_name: 'BILLING_CYCLE_RENEWAL',
      }).success,
    ).toBe(true);
    expect(auditLogViewSchema.safeParse({ ...entry, actor_role: null }).success).toBe(false);
  });

  it('checks the query: known keys, a limit of 1 to 100', () => {
    expect(auditLogQuerySchema.safeParse({}).success).toBe(true);
    expect(
      auditLogQuerySchema.safeParse({ vendor_id: SHOP_ID, action: 'PAN_VERIFIED', limit: 100 })
        .success,
    ).toBe(true);
    expect(auditLogQuerySchema.safeParse({ limit: 101 }).success).toBe(false);
    expect(auditLogQuerySchema.safeParse({ vendor_id: 'thamel' }).success).toBe(false);
    expect(auditLogQuerySchema.safeParse({ actor: 'Sarita' }).success).toBe(false);
  });

  it('turns the filters into the query, leaving "all" out', () => {
    expect(auditQueryOf(NO_AUDIT_FILTERS)).toEqual({});
    expect(
      auditQueryOf({ action: 'PAN_VERIFIED', entityType: 'vendor', search: 'ignored' }),
    ).toEqual({ action: 'PAN_VERIFIED', entity_type: 'vendor' });
    expect(auditQueryOf({ ...NO_AUDIT_FILTERS, action: 'drop table' })).toBeNull();
  });
});

describe('audit log rows', () => {
  const all = [entry, optIn];

  it('lists the newest entry first', () => {
    expect(auditRows(all, NO_AUDIT_FILTERS).map((row) => row.id)).toEqual([optIn.id, entry.id]);
  });

  it('filters by action, by record type and by actor or shop', () => {
    expect(
      auditRows(all, { ...NO_AUDIT_FILTERS, action: 'CAMPAIGN_OPTED_IN' }).map((row) => row.id),
    ).toEqual([optIn.id]);
    expect(
      auditRows(all, { ...NO_AUDIT_FILTERS, entityType: 'vendor_ledger' }).map((row) => row.id),
    ).toEqual([entry.id]);
    expect(
      auditRows(all, { ...NO_AUDIT_FILTERS, search: ' sarita ' }).map((row) => row.id),
    ).toEqual([entry.id]);
    expect(auditRows(all, { ...NO_AUDIT_FILTERS, search: 'asan' }).map((row) => row.id)).toEqual([
      entry.id,
    ]);
    expect(auditRows(all, { action: 'PAN_VERIFIED', entityType: '', search: '' })).toEqual([]);
  });

  it('offers the actions and record types that occur, sorted', () => {
    expect(auditOptions(all, 'action')).toEqual(['CAMPAIGN_OPTED_IN', 'SETTLEMENT_MODEL_CHANGED']);
    expect(auditOptions([entry, entry], 'entity_type')).toEqual(['vendor_ledger']);
  });

  it('words the action and the actor', () => {
    expect(actionLabel('SETTLEMENT_MODEL_CHANGED')).toBe('Settlement model changed');
    expect(actorLabel(entry)).toBe('Sarita (Super Admin)');
    expect(actorLabel(optIn)).toBe('Thamel Kirana Pasal (Vendor)');
    // The platform's own job: no user and no role.
    expect(actorLabel({ actor_name: 'VENDOR_COMPLIANCE_SWEEP', actor_role: null })).toBe(
      'VENDOR_COMPLIANCE_SWEEP (System)',
    );
  });
});

describe('the before / after difference', () => {
  it('marks what changed and what stayed', () => {
    expect(stateDiff(entry.before_state, entry.after_state)).toEqual([
      { path: 'balance_npr', kind: 'UNCHANGED', before: '320', after: '320' },
      {
        path: 'settlement_model',
        kind: 'CHANGED',
        before: '"COD_CREDIT"',
        after: '"PLATFORM_ESCROW"',
      },
    ]);
  });

  it('marks added and removed fields', () => {
    expect(stateDiff({ a: 1, gone: true }, { a: 1, fresh: null })).toEqual([
      { path: 'a', kind: 'UNCHANGED', before: '1', after: '1' },
      { path: 'fresh', kind: 'ADDED', before: null, after: 'null' },
      { path: 'gone', kind: 'REMOVED', before: 'true', after: null },
    ]);
  });

  it('walks nested objects by dotted path and treats a list as one value', () => {
    expect(
      stateDiff(
        { terms: { value: 10, cap: 150 }, methods: ['COD'] },
        { terms: { value: 12, cap: 150 }, methods: ['ESEWA', 'COD'] },
      ),
    ).toEqual([
      { path: 'methods', kind: 'CHANGED', before: '["COD"]', after: '["ESEWA","COD"]' },
      { path: 'terms.cap', kind: 'UNCHANGED', before: '150', after: '150' },
      { path: 'terms.value', kind: 'CHANGED', before: '10', after: '12' },
    ]);
  });

  it('shows a creation as every field added', () => {
    const rows = stateDiff(null, { terms_version: 2, terms: { kind: 'FLAT' } });
    expect(rows.map((row) => row.kind)).toEqual(['ADDED', 'ADDED']);
    expect(rows.map((row) => row.path)).toEqual(['terms.kind', 'terms_version']);
    expect(stateDiff(null, {})).toEqual([]);
  });

  it('tells a number from the same digits as text, and a missing field from null', () => {
    expect(stateDiff({ total: 860 }, { total: '860' })[0]?.kind).toBe('CHANGED');
    expect(stateDiff({ total: 860 }, { total: 860.0 })[0]?.kind).toBe('UNCHANGED');
    expect(stateDiff({ verified_at: null }, {})[0]).toEqual({
      path: 'verified_at',
      kind: 'REMOVED',
      before: 'null',
      after: null,
    });
  });

  it('summarises the difference and hides unchanged fields until asked', () => {
    const rows = stateDiff({ a: 1, b: 2, gone: 0 }, { a: 1, b: 3, fresh: 0 });
    expect(diffSummary(rows)).toBe('1 changed · 1 added · 1 removed');
    expect(visibleDiff(rows, false).map((row) => row.path)).toEqual(['b', 'fresh', 'gone']);
    expect(visibleDiff(rows, true)).toEqual(rows);
  });

  it('never alters the entry it reads', () => {
    const loaded = [entry, optIn, sweep];
    const snapshot = JSON.stringify(loaded);
    for (const sample of loaded) {
      stateDiff(sample.before_state, sample.after_state);
      rawState(sample.before_state);
    }
    auditRows(loaded, NO_AUDIT_FILTERS);
    expect(JSON.stringify(loaded)).toBe(snapshot);
  });

  it('prints the raw state as stored', () => {
    expect(rawState({ a: 1 })).toBe('{\n  "a": 1\n}');
    expect(rawState(null)).toBe('null (nothing existed before)');
  });
});

describe('createAdminApi (audit log endpoint)', () => {
  const CURSOR = optIn.id;

  it('sends the two filters and the cursor as query parameters, and only those', async () => {
    const { calls, api } = fakeAdminApi((call) =>
      call.includes('cursor=')
        ? { body: { entries: [entry], next_cursor: null } }
        : { body: { entries: [sweep, optIn], next_cursor: CURSOR } },
    );

    const first = await api.listAuditLogs({});
    await api.listAuditLogs({ action: 'PAN_VERIFIED', entityType: 'vendor' });
    const second = await api.listAuditLogs({
      action: 'PAN_VERIFIED',
      cursor: first.next_cursor ?? '',
    });

    expect(calls).toEqual([
      { call: 'GET /api/admin/audit-logs', body: undefined },
      { call: 'GET /api/admin/audit-logs?action=PAN_VERIFIED&entity_type=vendor', body: undefined },
      { call: `GET /api/admin/audit-logs?action=PAN_VERIFIED&cursor=${CURSOR}`, body: undefined },
    ]);
    // The pages, in the order they were loaded, are the list.
    expect(auditEntriesOf([first, second]).map((loaded) => loaded.id)).toEqual([
      sweep.id,
      optIn.id,
      entry.id,
    ]);
    expect(second.next_cursor).toBeNull();
  });

  it('has no method that writes the trail', () => {
    const { api } = fakeAdminApi(() => ({ body: { entries: [], next_cursor: null } }));
    expect(Object.keys(api).filter((name) => /audit/i.test(name))).toEqual(['listAuditLogs']);
  });

  it('refuses an entry with no actor, or with two', async () => {
    const { api } = fakeAdminApi(() => ({
      body: { entries: [{ ...sweep, system_actor: null }], next_cursor: null },
    }));
    await expect(api.listAuditLogs({})).rejects.toMatchObject({ code: 'UNEXPECTED_RESPONSE' });
  });

  it('words a failed load', async () => {
    const { api } = fakeAdminApi(() => refusalOf(400, 'INVALID_CURSOR'));
    const error: unknown = await api
      .listAuditLogs({ cursor: CURSOR })
      .catch((caught: unknown) => caught);
    expect(auditLoadErrorMessage(error)).toBe('The list changed. Refresh to start from the top.');
    expect(auditLoadErrorMessage(new ApiError(0, 'NETWORK_ERROR', 'x'))).toBe(
      'The API cannot be reached.',
    );
    expect(auditLoadErrorMessage(new Error('boom'))).toBe('The audit log could not be loaded.');
  });

  it('offers every action the platform can write, whatever is loaded', () => {
    const actions = auditFilterOptions([entry], 'action');
    expect(actions).toEqual([...actions].sort());
    expect(actions).toEqual(
      expect.arrayContaining(['PAN_VERIFIED', 'PAYOUT_PROCESSED', 'SETTLEMENT_MODEL_CHANGED']),
    );
    expect(auditFilterOptions([], 'entity_type')).toEqual(
      expect.arrayContaining(['vendor', 'platform_settings']),
    );
    expect(new Set(actions).size).toBe(actions.length);
    // An action newer than this build still gets its option once an entry carries it.
    expect(auditFilterOptions([{ ...entry, action: 'SOMETHING_NEW' }], 'action')).toContain(
      'SOMETHING_NEW',
    );
  });
});
