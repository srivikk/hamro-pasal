import { randomUUID } from 'node:crypto';

import { PAN_STANDINGS, panStandingOf } from './admin-governance';
import {
  pricingPlanCreateRequestSchema,
  pricingPlanUpdateRequestSchema,
  pricingPlanViewSchema,
} from './admin-pricing';
import {
  settlementPayoutRequestSchema,
  settlementPayoutResponseSchema,
  settlementVendorViewSchema,
} from './finance';
import {
  cartQuoteResponseSchema,
  feedEntrySchema,
  feedResponseSchema,
  vendorMenuSchema,
} from './responses';

describe('pricing plan contracts', () => {
  const commission = {
    name: 'Standard 10%',
    model: 'COMMISSION',
    commission_rate: 10,
    monthly_fee_npr: 0,
    duration_cycles: null,
    is_offered: true,
    is_default: false,
  };
  const creates = (plan: unknown) => pricingPlanCreateRequestSchema.safeParse(plan).success;

  it('takes each model with its own terms and no other', () => {
    expect(creates(commission)).toBe(true);
    expect(
      creates({ ...commission, model: 'SUBSCRIPTION', commission_rate: 0, monthly_fee_npr: 1500 }),
    ).toBe(true);
    expect(creates({ ...commission, model: 'FREE', commission_rate: 0, duration_cycles: 3 })).toBe(
      true,
    );
    // A rate and a fee are strictly above 0; only FREE charges nothing.
    expect(creates({ ...commission, commission_rate: 0 })).toBe(false);
    expect(creates({ ...commission, model: 'SUBSCRIPTION', commission_rate: 0 })).toBe(false);
    expect(creates({ ...commission, monthly_fee_npr: 100 })).toBe(false);
    expect(creates({ ...commission, duration_cycles: 3 })).toBe(false);
    expect(creates({ ...commission, model: 'FREE', commission_rate: 0 })).toBe(false);
    expect(creates({ ...commission, model: 'FREE', commission_rate: 0, duration_cycles: 37 })).toBe(
      false,
    );
  });

  it('lets only an offered Commission plan be created as the default', () => {
    expect(creates({ ...commission, is_default: true })).toBe(true);
    expect(creates({ ...commission, is_default: true, is_offered: false })).toBe(false);
    expect(
      creates({
        ...commission,
        model: 'SUBSCRIPTION',
        commission_rate: 0,
        monthly_fee_npr: 1500,
        is_default: true,
      }),
    ).toBe(false);
  });

  it('has no terms in an edit: a model, rate, fee or duration is refused', () => {
    const edit = { name: 'Standard', is_offered: true, is_default: false };
    expect(pricingPlanUpdateRequestSchema.safeParse(edit).success).toBe(true);
    for (const terms of [
      { model: 'FREE' },
      { commission_rate: 5 },
      { monthly_fee_npr: 1 },
      { duration_cycles: 2 },
    ]) {
      expect(pricingPlanUpdateRequestSchema.safeParse({ ...edit, ...terms }).success).toBe(false);
    }
    expect(Object.keys(pricingPlanUpdateRequestSchema.shape).sort()).toEqual([
      'is_default',
      'is_offered',
      'name',
    ]);
    // The default stays on offer.
    expect(
      pricingPlanUpdateRequestSchema.safeParse({ ...edit, is_default: true, is_offered: false })
        .success,
    ).toBe(false);
  });

  it('views a plan with its read-only vendor count', () => {
    const view = {
      id: randomUUID(),
      ...commission,
      vendor_count: 6,
      created_at: '2026-10-08T06:00:00.000Z',
    };
    expect(pricingPlanViewSchema.safeParse(view).success).toBe(true);
    expect(pricingPlanViewSchema.safeParse({ ...view, vendor_count: -1 }).success).toBe(false);
  });
});

describe('settlement contracts', () => {
  const vendor = {
    vendor_id: randomUUID(),
    business_name: 'Thamel Kirana Pasal',
    phone: '+9779800000011',
    settlement_model: 'PLATFORM_ESCROW',
    available_for_payout_npr: 8450,
    pending_escrow_npr: 3200,
    tax_id: '302118845',
    pan_verified_at: null,
    primary_bank_account: null,
  };
  const request = {
    amount_npr: 8450,
    bank_reference: 'NIC-ASIA-778812',
    idempotency_key: randomUUID(),
  };

  it('views a shop with its PAN verification, never a negative amount', () => {
    expect(settlementVendorViewSchema.safeParse(vendor).success).toBe(true);
    expect(
      settlementVendorViewSchema.safeParse({ ...vendor, available_for_payout_npr: -1 }).success,
    ).toBe(false);
    expect(
      settlementVendorViewSchema.safeParse({
        ...vendor,
        tax_id: null,
        pan_verified_at: '2026-10-08T06:00:00.000Z',
      }).success,
    ).toBe(false);
  });

  it('takes any positive amount in whole paisa: a manual payout has no minimum', () => {
    for (const amount of [0.01, 1, 999.99, 1_000_000]) {
      expect(
        settlementPayoutRequestSchema.safeParse({ ...request, amount_npr: amount }).success,
      ).toBe(true);
    }
    for (const amount of [0, -1, 0.001, 1_000_000.01, '100']) {
      expect(
        settlementPayoutRequestSchema.safeParse({ ...request, amount_npr: amount }).success,
      ).toBe(false);
    }
  });

  it('needs a bank reference and a key, and names no vendor or status', () => {
    expect(settlementPayoutRequestSchema.parse({ ...request, bank_reference: ' REF ' })).toEqual({
      ...request,
      bank_reference: 'REF',
    });
    for (const body of [
      { ...request, bank_reference: '  ' },
      { ...request, idempotency_key: 'short' },
      { ...request, vendor_id: vendor.vendor_id },
      { ...request, status: 'APPROVED' },
      { amount_npr: 100, bank_reference: 'REF' },
    ]) {
      expect(settlementPayoutRequestSchema.safeParse(body).success).toBe(false);
    }
  });

  it('answers with the payout, the shop after it, and whether it was a replay', () => {
    expect(
      settlementPayoutResponseSchema.safeParse({
        payout: {
          id: randomUUID(),
          amount_npr: 8450,
          status: 'APPROVED',
          bank_reference: 'NIC-ASIA-778812',
          rejection_reason: null,
          requested_at: '2026-10-08T06:00:00.000Z',
          decided_at: '2026-10-08T06:00:00.000Z',
        },
        vendor: {
          ...vendor,
          available_for_payout_npr: 0,
          pan_verified_at: '2026-10-08T05:00:00.000Z',
        },
        replayed: false,
      }).success,
    ).toBe(true);
  });
});

describe('panStandingOf', () => {
  it('ranks a shop worst first', () => {
    expect(PAN_STANDINGS).toEqual(['SUSPENDED', 'MISSING', 'UNVERIFIED', 'VERIFIED']);
    expect(
      panStandingOf({ status: 'SUSPENDED_COMPLIANCE', tax_id: null, pan_verified_at: null }),
    ).toBe('SUSPENDED');
    expect(panStandingOf({ status: 'LIVE', tax_id: null, pan_verified_at: null })).toBe('MISSING');
    // A debt suspension without a PAN is "missing": it is not a compliance suspension.
    expect(panStandingOf({ status: 'SUSPENDED', tax_id: null, pan_verified_at: null })).toBe(
      'MISSING',
    );
    expect(panStandingOf({ status: 'LIVE', tax_id: '302118845', pan_verified_at: null })).toBe(
      'UNVERIFIED',
    );
    expect(
      panStandingOf({
        status: 'LIVE',
        tax_id: '302118845',
        pan_verified_at: '2026-10-08T06:00:00.000Z',
      }),
    ).toBe('VERIFIED');
  });
});

describe('delivery_available', () => {
  const entry = {
    vendor: {
      id: randomUUID(),
      business_name: 'Thamel Kirana Pasal',
      delivery_scope: 'RADIUS_BOUND',
      radius_km: 5,
      municipality_palika_string: 'Kathmandu Metropolitan City',
      min_order_value: 500,
      base_delivery_fee_npr: 50,
      fulfillment_mode: 'SELF_DELIVERY',
      location: { x: 85.3123, y: 27.7154 },
    },
    distance_km: 1.2,
    serviceable: true,
  };
  const quote = {
    subtotal_npr: 600,
    vendor_offer: null,
    platform_promo: null,
    delivery_fee_npr: 50,
    distance_km: 1.2,
    total_npr: 650,
    payment_options: [{ method: 'COD', available: false, reason: 'DELIVERY_UNAVAILABLE' }],
  };

  it('is carried by the feed, each feed entry, the menu and the quote', () => {
    expect(feedEntrySchema.parse({ ...entry, delivery_available: false }).delivery_available).toBe(
      false,
    );
    expect(
      feedResponseSchema.parse({ serviceable: [], explore_further: [], delivery_available: false })
        .delivery_available,
    ).toBe(false);
    expect(
      vendorMenuSchema.parse({
        vendor: entry.vendor,
        serviceable: false,
        delivery_available: false,
        products: [],
      }).delivery_available,
    ).toBe(false);
    expect(
      cartQuoteResponseSchema.parse({ ...quote, delivery_available: false }).delivery_available,
    ).toBe(false);
  });

  it('reads a response from before the field as "available"', () => {
    expect(feedEntrySchema.parse(entry).delivery_available).toBe(true);
    expect(feedResponseSchema.parse({ serviceable: [entry], explore_further: [] })).toMatchObject({
      delivery_available: true,
      serviceable: [{ delivery_available: true }],
    });
    expect(
      vendorMenuSchema.parse({ vendor: entry.vendor, serviceable: true, products: [] })
        .delivery_available,
    ).toBe(true);
    expect(cartQuoteResponseSchema.parse(quote).delivery_available).toBe(true);
  });

  it('is a boolean, and the schemas stay strict', () => {
    expect(feedEntrySchema.safeParse({ ...entry, delivery_available: 'no' }).success).toBe(false);
    expect(feedEntrySchema.safeParse({ ...entry, delivery_unavailable: true }).success).toBe(false);
  });
});
