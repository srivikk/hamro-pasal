import { randomUUID } from 'node:crypto';

import {
  ADMIN_AUDIT_LOG_MAX_LIMIT,
  adminAuditLogListQuerySchema,
  auditLogViewSchema,
  complianceVendorViewSchema,
  logisticsSettingsViewSchema,
  logisticsSettingsWriteSchema,
  MAX_FREE_DELIVERY_THRESHOLD_NPR,
  MAX_PLATFORM_DELIVERY_FEE_NPR,
  PLATFORM_SETTINGS_ENTITY_ID,
} from './admin-governance';

const entry = {
  id: randomUUID(),
  occurred_at: '2026-10-08T05:12:44.123Z',
  actor_user_id: randomUUID(),
  actor_role: 'SUPER_ADMIN',
  system_actor: null,
  actor_name: 'Sarita',
  action: 'LOGISTICS_SETTINGS_CHANGED',
  vendor_id: null,
  vendor_name: null,
  entity_type: 'platform_settings',
  entity_id: PLATFORM_SETTINGS_ENTITY_ID,
  before_state: { platform_delivery_fee_npr: 50 },
  after_state: { platform_delivery_fee_npr: 80 },
  request_id: 'req-1',
  ip_address: '103.10.28.14',
  user_agent: null,
};

describe('auditLogViewSchema', () => {
  it('accepts a user entry, a creation, and a job entry', () => {
    expect(auditLogViewSchema.safeParse(entry).success).toBe(true);
    expect(auditLogViewSchema.safeParse({ ...entry, before_state: null }).success).toBe(true);
    expect(
      auditLogViewSchema.safeParse({
        ...entry,
        actor_user_id: null,
        actor_role: null,
        system_actor: 'VENDOR_COMPLIANCE_SWEEP',
        actor_name: 'VENDOR_COMPLIANCE_SWEEP',
      }).success,
    ).toBe(true);
  });

  it('needs exactly one kind of actor', () => {
    for (const actor of [
      { actor_user_id: null },
      { actor_role: null },
      { system_actor: 'BILLING_CYCLE_RENEWAL' },
      { actor_user_id: null, actor_role: null },
    ]) {
      expect(auditLogViewSchema.safeParse({ ...entry, ...actor }).success).toBe(false);
    }
  });

  it('refuses a missing after state, a malformed action and unknown keys', () => {
    expect(auditLogViewSchema.safeParse({ ...entry, after_state: null }).success).toBe(false);
    expect(auditLogViewSchema.safeParse({ ...entry, after_state: [1] }).success).toBe(false);
    expect(auditLogViewSchema.safeParse({ ...entry, action: 'plan edited' }).success).toBe(false);
    expect(auditLogViewSchema.safeParse({ ...entry, actor_role: 'SYSTEM' }).success).toBe(false);
    expect(auditLogViewSchema.safeParse({ ...entry, phone: '+9779800000099' }).success).toBe(false);
  });
});

describe('adminAuditLogListQuerySchema', () => {
  it('reads every filter from query strings', () => {
    const ids = { vendor_id: randomUUID(), actor_user_id: randomUUID(), entity_id: randomUUID() };
    const cursor = randomUUID();
    expect(
      adminAuditLogListQuerySchema.parse({
        ...ids,
        entity_type: 'vendor',
        action: 'PAN_VERIFIED',
        limit: '25',
        cursor,
      }),
    ).toEqual({ ...ids, entity_type: 'vendor', action: 'PAN_VERIFIED', limit: 25, cursor });
    expect(adminAuditLogListQuerySchema.parse({})).toEqual({});
  });

  it('takes a limit of 1 to the maximum, as text or a number', () => {
    expect(adminAuditLogListQuerySchema.parse({ limit: ADMIN_AUDIT_LOG_MAX_LIMIT }).limit).toBe(
      100,
    );
    for (const limit of ['0', '101', '1.5', 'ten', '', ['1', '2'], -1]) {
      expect(adminAuditLogListQuerySchema.safeParse({ limit }).success).toBe(false);
    }
  });

  it('refuses malformed ids, names and unknown filters', () => {
    for (const query of [
      { vendor_id: 'thamel' },
      { actor_user_id: '1' },
      { entity_id: 'x' },
      { cursor: 'x' },
      { action: 'drop table' },
      { entity_type: 'Vendor' },
      { target_id: randomUUID() },
      { actor: 'Sarita' },
    ]) {
      expect(adminAuditLogListQuerySchema.safeParse(query).success).toBe(false);
    }
  });
});

describe('logistics settings', () => {
  const write = {
    self_delivery_enabled: true,
    platform_fleet_enabled: true,
    platform_delivery_fee_npr: 50,
  };

  it('takes an optional platform free-delivery threshold: absent, null, or above 0 in whole paisa', () => {
    const parse = (value: unknown) =>
      logisticsSettingsWriteSchema.safeParse({ ...write, free_delivery_above_npr: value });
    expect(logisticsSettingsWriteSchema.safeParse(write).success).toBe(true);
    expect(parse(null).success).toBe(true);
    expect(parse(100).success).toBe(true);
    expect(parse(MAX_FREE_DELIVERY_THRESHOLD_NPR).success).toBe(true);
    for (const bad of [0, -1, 10.005, MAX_FREE_DELIVERY_THRESHOLD_NPR + 1, '100']) {
      expect(parse(bad).success).toBe(false);
    }
  });

  it('takes a fee from 0 to the maximum in whole paisa', () => {
    for (const fee of [0, 0.01, 49.5, MAX_PLATFORM_DELIVERY_FEE_NPR]) {
      expect(
        logisticsSettingsWriteSchema.safeParse({ ...write, platform_delivery_fee_npr: fee })
          .success,
      ).toBe(true);
    }
    for (const fee of [-1, 0.001, MAX_PLATFORM_DELIVERY_FEE_NPR + 0.01, '50', null]) {
      expect(
        logisticsSettingsWriteSchema.safeParse({ ...write, platform_delivery_fee_npr: fee })
          .success,
      ).toBe(false);
    }
  });

  it('accepts both modes off (the Emergency Stop) and nothing but the three settings', () => {
    expect(
      logisticsSettingsWriteSchema.safeParse({
        ...write,
        self_delivery_enabled: false,
        platform_fleet_enabled: false,
      }).success,
    ).toBe(true);
    expect(logisticsSettingsWriteSchema.safeParse({ self_delivery_enabled: true }).success).toBe(
      false,
    );
    expect(
      logisticsSettingsWriteSchema.safeParse({ ...write, vendor_wallet_suspension_limit_npr: 0 })
        .success,
    ).toBe(false);
  });

  it('views the settings with the read-only mode counts', () => {
    const view = {
      ...write,
      free_delivery_above_npr: null,
      self_delivery_vendor_count: 5,
      platform_fleet_vendor_count: 4,
      updated_at: '2026-10-08T06:00:00.000Z',
    };
    expect(logisticsSettingsViewSchema.safeParse(view).success).toBe(true);
    expect(
      logisticsSettingsViewSchema.safeParse({ ...view, self_delivery_vendor_count: -1 }).success,
    ).toBe(false);
  });
});

describe('complianceVendorViewSchema', () => {
  const vendor = {
    id: randomUUID(),
    business_name: 'Thamel Kirana Pasal',
    phone: '+9779800000011',
    municipality_palika_string: 'Kathmandu Metropolitan City',
    status: 'LIVE',
    restore_status: null,
    compliance_suspended_at: null,
    legal_name: null,
    tax_id: '302118845',
    is_vat_registered: false,
    pan_verified_at: '2026-10-08T06:00:00.000Z',
  };

  it('accepts a verified shop and a shop suspended for compliance', () => {
    expect(complianceVendorViewSchema.safeParse(vendor).success).toBe(true);
    expect(
      complianceVendorViewSchema.safeParse({
        ...vendor,
        status: 'SUSPENDED_COMPLIANCE',
        restore_status: 'LIVE',
        compliance_suspended_at: '2026-10-08T00:00:00.000Z',
        tax_id: null,
        pan_verified_at: null,
      }).success,
    ).toBe(true);
  });

  it('holds what the database guarantees', () => {
    // A verification without a PAN.
    expect(complianceVendorViewSchema.safeParse({ ...vendor, tax_id: null }).success).toBe(false);
    // A compliance suspension with nothing to return to.
    expect(
      complianceVendorViewSchema.safeParse({ ...vendor, status: 'SUSPENDED_COMPLIANCE' }).success,
    ).toBe(false);
    // Never back to a suspension.
    expect(
      complianceVendorViewSchema.safeParse({ ...vendor, restore_status: 'SUSPENDED' }).success,
    ).toBe(false);
    expect(complianceVendorViewSchema.safeParse({ ...vendor, tax_id: '30211884' }).success).toBe(
      false,
    );
  });

  it('carries no verifier id or wallet', () => {
    expect(
      complianceVendorViewSchema.safeParse({ ...vendor, pan_verified_by_user_id: randomUUID() })
        .success,
    ).toBe(false);
  });
});
