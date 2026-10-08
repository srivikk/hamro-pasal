import { randomUUID } from 'node:crypto';

import { AUDIT_ACTION_ENTITY_TYPES } from '../audit/audit-log';
import { vendorSchema } from '../domain/entities';
import { settlementModels } from '../domain/enums';
import {
  adProductCreateRequestSchema,
  adProductUpdateRequestSchema,
  campaignOptInRequestSchema,
  campaignWriteRequestSchema,
  MAX_DISCOUNT_TAG_LENGTH,
  promotionWriteRequestSchema,
} from './admin-marketing';
import { settlementVendorViewSchema } from './finance';
import {
  bankAccountViewSchema,
  bankAccountWriteRequestSchema,
  maskAccountNumber,
} from './vendor-banking';

describe('settlement model', () => {
  it('has the three models of SPEC, and every vendor row carries one', () => {
    expect(settlementModels).toEqual(['COD_CREDIT', 'PLATFORM_ESCROW', 'DIRECT_PREPAID']);
    expect(Object.keys(vendorSchema.shape)).toContain('settlement_model');
  });
});

describe('bank account contracts', () => {
  const account = {
    bank_name: 'Nabil Bank',
    branch_name: 'Thamel',
    account_name: 'Thamel Kirana Pasal',
    account_number: '0123456789012',
    routing_or_swift_code: null,
    is_primary: true,
  };
  const writes = (body: unknown) => bankAccountWriteRequestSchema.safeParse(body).success;

  it('takes an account with letters and digits only, and an optional routing code', () => {
    expect(bankAccountWriteRequestSchema.parse({ ...account, bank_name: ' Nabil Bank ' })).toEqual(
      account,
    );
    expect(writes({ ...account, routing_or_swift_code: 'NARBNPKA' })).toBe(true);
    for (const body of [
      { ...account, account_number: '123' },
      { ...account, account_number: '0123 4567' },
      { ...account, account_number: 'x'.repeat(35) },
      { ...account, routing_or_swift_code: 'NAR' },
      { ...account, branch_name: '  ' },
      { ...account, is_primary: undefined },
    ]) {
      expect(writes(body)).toBe(false);
    }
  });

  it('names no vendor and no id: the shop is the caller’s', () => {
    expect(writes({ ...account, vendor_id: randomUUID() })).toBe(false);
    expect(writes({ ...account, id: randomUUID() })).toBe(false);
  });

  it('shows the vendor its number in full and masks it for the audit trail', () => {
    expect(
      bankAccountViewSchema.safeParse({
        id: randomUUID(),
        ...account,
        created_at: '2026-10-08T06:00:00.000Z',
        updated_at: '2026-10-08T06:00:00.000Z',
      }).success,
    ).toBe(true);
    expect(maskAccountNumber('0123456789012')).toBe('****9012');
    expect(maskAccountNumber('AB12')).toBe('****AB12');
  });

  it('is audited as its own record type', () => {
    expect(AUDIT_ACTION_ENTITY_TYPES.BANK_ACCOUNT_ADDED).toBe('vendor_bank_account');
    expect(AUDIT_ACTION_ENTITY_TYPES.BANK_ACCOUNT_UPDATED).toBe('vendor_bank_account');
  });

  it('puts the primary account, or its absence, on the settlement row', () => {
    const row = {
      vendor_id: randomUUID(),
      business_name: 'Thamel Kirana Pasal',
      phone: '+9779800000011',
      settlement_model: 'PLATFORM_ESCROW',
      available_for_payout_npr: 8450,
      pending_escrow_npr: 0,
      tax_id: '302118845',
      pan_verified_at: '2026-10-08T06:00:00.000Z',
      primary_bank_account: null,
    };
    expect(settlementVendorViewSchema.safeParse(row).success).toBe(true);
    expect(
      settlementVendorViewSchema.safeParse({
        ...row,
        primary_bank_account: {
          id: randomUUID(),
          bank_name: 'Nabil Bank',
          branch_name: 'Thamel',
          account_name: 'Thamel Kirana Pasal',
          account_number: '0123456789012',
          routing_or_swift_code: null,
        },
      }).success,
    ).toBe(true);
    const { primary_bank_account: _omitted, ...without } = row;
    expect(settlementVendorViewSchema.safeParse(without).success).toBe(false);
  });
});

describe('campaign contracts', () => {
  const campaign = {
    name: 'Dashain 10%',
    kind: 'PERCENTAGE',
    value: 10,
    max_discount_npr: 200,
    min_cart_npr: 500,
    vendor_share_percent: 50,
    starts_at: '2026-10-09T18:15:00.000Z',
    ends_at: '2026-10-25T18:14:59.000Z',
    is_active: true,
  };
  const writes = (body: unknown) => campaignWriteRequestSchema.safeParse(body).success;

  it('takes a percentage with an optional cap, or a flat amount without one', () => {
    expect(writes(campaign)).toBe(true);
    expect(writes({ ...campaign, kind: 'FLAT', value: 150, max_discount_npr: null })).toBe(true);
    expect(writes({ ...campaign, value: 101 })).toBe(false);
    expect(writes({ ...campaign, kind: 'FLAT', value: 150 })).toBe(false);
    expect(writes({ ...campaign, ends_at: campaign.starts_at })).toBe(false);
  });

  it('carries no vendor, opt-in or version: an admin cannot enrol a shop or set the version', () => {
    for (const key of ['vendor_id', 'vendor_ids', 'opt_ins', 'terms_version', 'opt_in_count']) {
      expect(writes({ ...campaign, [key]: 1 })).toBe(false);
    }
  });

  it('takes an opt-in as the accepted terms version and nothing else', () => {
    expect(campaignOptInRequestSchema.safeParse({ terms_version: 2 }).success).toBe(true);
    for (const body of [
      {},
      { terms_version: 0 },
      { terms_version: '2' },
      { terms_version: 2, vendor_id: randomUUID() },
    ]) {
      expect(campaignOptInRequestSchema.safeParse(body).success).toBe(false);
    }
  });
});

describe('ad product contracts', () => {
  const product = {
    name: 'Carousel Placement (7 days)',
    slot: 'CAROUSEL',
    billing_model: 'FLAT_RATE',
    price_npr: 5000,
    duration_days: 7,
    is_active: true,
  };

  it('sells the two placements at an NPR price, and names no vendor', () => {
    expect(adProductCreateRequestSchema.safeParse(product).success).toBe(true);
    expect(
      adProductCreateRequestSchema.safeParse({ ...product, slot: 'FEED_LISTING' }).success,
    ).toBe(true);
    for (const overrides of [
      { slot: 'FEATURED' },
      { price_npr: 0 },
      { duration_days: 91 },
      { vendor_id: randomUUID() },
    ]) {
      expect(adProductCreateRequestSchema.safeParse({ ...product, ...overrides }).success).toBe(
        false,
      );
    }
  });

  it('has no terms in an edit', () => {
    expect(Object.keys(adProductUpdateRequestSchema.shape).sort()).toEqual(['is_active', 'name']);
    for (const terms of [{ price_npr: 1 }, { duration_days: 30 }, { slot: 'CAROUSEL' }]) {
      expect(
        adProductUpdateRequestSchema.safeParse({ name: 'x', is_active: true, ...terms }).success,
      ).toBe(false);
    }
  });
});

describe('promotion contract', () => {
  const promotion = {
    placement: 'FEATURED',
    image_url: null,
    title: '10% OFF',
    subtitle: null,
    target_type: 'DISCOUNT_TAG',
    target_value: '10% OFF',
    display_order: 0,
    is_active: true,
    starts_at: null,
    ends_at: null,
    is_sponsored: false,
    ad_purchase_id: null,
  };
  const writes = (overrides: Record<string, unknown>) =>
    promotionWriteRequestSchema.safeParse({ ...promotion, ...overrides }).success;

  it('fits the target value to its type', () => {
    const shop = randomUUID();
    expect(writes({})).toBe(true);
    expect(writes({ target_value: 'x'.repeat(MAX_DISCOUNT_TAG_LENGTH) })).toBe(true);
    expect(writes({ target_value: 'x'.repeat(MAX_DISCOUNT_TAG_LENGTH + 1) })).toBe(false);
    expect(writes({ target_type: 'SHOP', target_value: shop })).toBe(true);
    expect(writes({ target_type: 'SHOP', target_value: 'thamel-kirana' })).toBe(false);
    expect(writes({ target_type: 'CATEGORY', target_value: 'festive-offers' })).toBe(true);
    expect(writes({ target_type: 'CATEGORY', target_value: 'Festive Offers' })).toBe(false);
    expect(writes({ target_type: 'CATEGORY', target_value: shop.toUpperCase() })).toBe(false);
    expect(writes({ target_type: null, target_value: null })).toBe(true);
    expect(writes({ target_type: null })).toBe(false);
  });

  it('is sponsored exactly when it names a purchase, and then targets a shop', () => {
    const shop = { target_type: 'SHOP', target_value: randomUUID() };
    expect(writes({ ...shop, is_sponsored: true, ad_purchase_id: randomUUID() })).toBe(true);
    expect(writes({ ...shop, is_sponsored: true })).toBe(false);
    expect(writes({ ...shop, ad_purchase_id: randomUUID() })).toBe(false);
    expect(writes({ is_sponsored: true, ad_purchase_id: randomUUID() })).toBe(false);
  });

  it('has no price or discount key: a promotion never changes what is charged', () => {
    for (const key of ['discount_percent', 'price_npr', 'target_id', 'sort_order']) {
      expect(writes({ [key]: 1 })).toBe(false);
    }
  });
});
