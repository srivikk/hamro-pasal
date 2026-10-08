import {
  AUDIT_ACTION_ENTITY_TYPES,
  AUDIT_ACTION_PATTERN,
  auditActions,
  auditActorSchema,
  auditContextSchema,
  auditEntityTypes,
  auditLogEntrySchema,
  auditStateSchema,
  forbiddenAuditKeys,
  NO_AUDIT_CONTEXT,
} from './audit-log';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const VENDOR_ID = '22222222-2222-4222-8222-222222222222';

const entry = {
  actor: { kind: 'USER', user_id: USER_ID, role: 'SUPER_ADMIN' },
  action: 'PAN_VERIFIED',
  entity_id: VENDOR_ID,
  vendor_id: VENDOR_ID,
  before_state: { tax_id: '302118845', pan_verified_at: null },
  after_state: { tax_id: '302118845', pan_verified_at: '2026-10-07T06:00:00.000Z' },
  context: NO_AUDIT_CONTEXT,
} as const;

const accepts = (candidate: unknown) => auditLogEntrySchema.safeParse(candidate).success;

describe('audit actions', () => {
  it('names every action in upper snake case and maps it to a known record type', () => {
    const pattern = new RegExp(AUDIT_ACTION_PATTERN);
    expect(auditActions.length).toBeGreaterThan(0);
    for (const action of auditActions) {
      expect(action).toMatch(pattern);
      expect(auditEntityTypes).toContain(AUDIT_ACTION_ENTITY_TYPES[action]);
    }
  });

  it('covers the actions the admin dashboard and the Vendor App will write', () => {
    expect(auditActions).toEqual(
      expect.arrayContaining([
        'CAMPAIGN_OPTED_IN',
        'CAMPAIGN_TERMS_CHANGED',
        'AD_PURCHASED',
        'SETTLEMENT_MODEL_CHANGED',
        'PAYOUT_PROCESSED',
        'PRICING_PLAN_UPDATED',
        'PAN_VERIFIED',
        'PAN_VERIFICATION_CLEARED',
        'LOGISTICS_SETTINGS_CHANGED',
        'PROMOTION_UPDATED',
      ]),
    );
  });

  it('uses every record type', () => {
    const used = new Set(Object.values(AUDIT_ACTION_ENTITY_TYPES));
    expect([...auditEntityTypes].sort()).toEqual([...used].sort());
  });
});

describe('audit actor', () => {
  it('is a user with a role, or a named job', () => {
    expect(auditActorSchema.safeParse(entry.actor).success).toBe(true);
    expect(
      auditActorSchema.safeParse({ kind: 'SYSTEM', job: 'BILLING_CYCLE_RENEWAL' }).success,
    ).toBe(true);
  });

  it('refuses an anonymous actor, a user without a role and a job that names a user', () => {
    expect(auditActorSchema.safeParse({ kind: 'USER', user_id: USER_ID }).success).toBe(false);
    expect(
      auditActorSchema.safeParse({ kind: 'USER', user_id: 'admin', role: 'VENDOR' }).success,
    ).toBe(false);
    expect(auditActorSchema.safeParse({ kind: 'SYSTEM' }).success).toBe(false);
    expect(auditActorSchema.safeParse({ kind: 'SYSTEM', job: 'nightly job' }).success).toBe(false);
    expect(
      auditActorSchema.safeParse({ kind: 'SYSTEM', job: 'SWEEP', user_id: USER_ID }).success,
    ).toBe(false);
    expect(auditActorSchema.safeParse({ kind: 'ANONYMOUS' }).success).toBe(false);
  });
});

describe('audit entry', () => {
  it('accepts a change and a creation', () => {
    expect(accepts(entry)).toBe(true);
    expect(accepts({ ...entry, before_state: null })).toBe(true);
    expect(accepts({ ...entry, vendor_id: null })).toBe(true);
  });

  it('refuses an unknown action, a missing state after and a record type from the caller', () => {
    expect(accepts({ ...entry, action: 'PLAN_EDITED' })).toBe(false);
    expect(accepts({ ...entry, after_state: null })).toBe(false);
    expect(accepts({ ...entry, entity_type: 'vendor' })).toBe(false);
    expect(accepts({ ...entry, entity_id: 'thamel' })).toBe(false);
  });

  it('takes a state that is a JSON object and nothing else', () => {
    expect(auditStateSchema.safeParse({ a: 1, nested: { list: [1, 'two', null] } }).success).toBe(
      true,
    );
    expect(auditStateSchema.safeParse([1, 2]).success).toBe(false);
    expect(auditStateSchema.safeParse('LIVE').success).toBe(false);
    expect(auditStateSchema.safeParse({ when: new Date() }).success).toBe(false);
    expect(auditStateSchema.safeParse({ amount: Number.NaN }).success).toBe(false);
  });

  it('checks the request context', () => {
    const withContext = (context: unknown) => accepts({ ...entry, context });
    expect(
      withContext({ request_id: 'req_1', ip_address: '103.10.28.14', user_agent: 'Chrome' }),
    ).toBe(true);
    expect(withContext({ ...NO_AUDIT_CONTEXT, ip_address: '2400:1a00:b030::1' })).toBe(true);
    expect(withContext({ ...NO_AUDIT_CONTEXT, ip_address: 'localhost' })).toBe(false);
    expect(withContext({ ...NO_AUDIT_CONTEXT, user_agent: 'x'.repeat(501) })).toBe(false);
    expect(withContext({ ...NO_AUDIT_CONTEXT, request_id: '' })).toBe(false);
    expect(auditContextSchema.safeParse({ request_id: null }).success).toBe(false);
  });
});

describe('secrets in an audited state', () => {
  it('finds forbidden field names at any depth, in objects and lists', () => {
    expect(forbiddenAuditKeys({ tax_id: '302118845', status: 'LIVE' })).toEqual([]);
    expect(forbiddenAuditKeys(null)).toEqual([]);
    expect(
      forbiddenAuditKeys({
        delivery_otp: '1234',
        gateway: { merchant_code: 'EPAYTEST', secret_ciphertext: 'abc' },
        sessions: [{ refresh_token: 'x' }, { ok: true }],
        Signature: 'i94z',
      }),
    ).toEqual([
      'delivery_otp',
      'gateway.secret_ciphertext',
      'sessions[0].refresh_token',
      'Signature',
    ]);
  });

  it('refuses an entry that carries one, before or after, and names the field', () => {
    const leaking = auditLogEntrySchema.safeParse({
      ...entry,
      after_state: { ...entry.after_state, gateway: { secret_key: '8gBm' } },
    });
    expect(leaking.success).toBe(false);
    expect(leaking.error?.issues[0]).toMatchObject({
      path: ['after_state'],
      message: 'Secrets are never audited: gateway.secret_key',
    });
    expect(accepts({ ...entry, before_state: { password: 'x' } })).toBe(false);
  });

  it('does not mistake ordinary fields for secrets', () => {
    expect(
      forbiddenAuditKeys({
        terms_version: 2,
        bank_reference: 'NIC-ASIA-778812',
        accepted_payment_methods: ['COD'],
        pan_verified_at: null,
      }),
    ).toEqual([]);
  });
});
