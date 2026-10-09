import { AUDIT_ACTION_ENTITY_TYPES } from '../audit/audit-log';
import {
  DOMAIN_EVENT_TOPICS,
  domainEventSchema,
  MAX_CAMPAIGN_EVENT_VENDORS,
} from '../events/domain-events';
import { vendorAnalyticsSummarySchema } from './vendor-analytics';
import { taxIdentityRequestSchema, taxIdentityResponseSchema } from './vendor-settings';

const VENDOR_ID = '11111111-1111-4111-8111-111111111111';
const AD_ID = '22222222-2222-4222-8222-222222222222';
const CAMPAIGN_ID = '33333333-3333-4333-8333-333333333333';
const ADMIN_ID = '99999999-9999-4999-8999-999999999999';
const AT = '2026-10-09T06:15:00.000Z';

const envelope = <P extends object>(type: string, aggregateId: string, payload: P) => ({
  event_id: '44444444-4444-4444-8444-444444444444',
  event_type: type,
  event_version: 1,
  occurred_at: AT,
  aggregate_id: aggregateId,
  payload,
});

const summary = {
  today_sales_npr: 855,
  today_order_count: 1,
  top_item: { product_name: 'Wai Wai Noodles', units_sold: 11, sales_npr: 208 },
  ad_roi: { spend_npr: 50, revenue_npr: 1000 },
  daily_sales: ['FRI', 'SAT', 'SUN', 'MON', 'TUE', 'WED', 'THU'].map((day) => ({
    day,
    sales_npr: 0,
  })),
};

describe('tax identity (Phase 35)', () => {
  it('takes the PAN and the VAT flag, and nothing that names a document or a verification', () => {
    expect(
      taxIdentityRequestSchema.safeParse({ tax_id: '302118845', is_vat_registered: true }).success,
    ).toBe(true);
    for (const body of [
      { tax_id: '302118845' },
      { tax_id: '302118845', is_vat_registered: 'yes' },
      { tax_id: '302118845', is_vat_registered: true, pan_document_url: 'kyc/pan/x.webp' },
      { tax_id: '302118845', is_vat_registered: true, pan_verified_at: AT },
    ]) {
      expect(taxIdentityRequestSchema.safeParse(body).success).toBe(false);
    }
  });

  it('says when a changed number removed the document, and reads an older answer as "no"', () => {
    const before = {
      vendor_id: VENDOR_ID,
      tax_id: '302118845',
      is_vat_registered: false,
      legal_name: null,
      registered_address: null,
      status: 'LIVE',
      compliance_suspension_lifted: false,
      pan_verified_at: null,
    };
    expect(taxIdentityResponseSchema.parse(before)).toMatchObject({
      pan_document_removed: false,
      has_pan_document: false,
      waiting_invoices_issued: 0,
    });
    expect(
      taxIdentityResponseSchema.parse({ ...before, pan_document_removed: true }),
    ).toMatchObject({ pan_document_removed: true });
    // Where the document is stored is never part of the answer.
    expect(
      taxIdentityResponseSchema.safeParse({ ...before, pan_document_url: 'kyc/pan/x.webp' })
        .success,
    ).toBe(false);
  });

  it('audits the removal on the vendor', () => {
    expect(AUDIT_ACTION_ENTITY_TYPES.PAN_DOCUMENT_REMOVED).toBe('vendor');
  });
});

describe('vendor analytics summary', () => {
  it('is today, the top item, the ad return and exactly seven days', () => {
    expect(vendorAnalyticsSummarySchema.safeParse(summary).success).toBe(true);
    expect(
      vendorAnalyticsSummarySchema.safeParse({ ...summary, top_item: null, ad_roi: null }).success,
    ).toBe(true);
  });

  it('refuses a short week, an unknown day, a negative amount and an unknown key', () => {
    for (const broken of [
      { ...summary, daily_sales: summary.daily_sales.slice(1) },
      { ...summary, daily_sales: [...summary.daily_sales, { day: 'FRI', sales_npr: 0 }] },
      {
        ...summary,
        daily_sales: summary.daily_sales.map((d, i) => (i === 0 ? { ...d, day: 'Fri' } : d)),
      },
      { ...summary, today_sales_npr: -1 },
      { ...summary, today_order_count: 1.5 },
      { ...summary, top_item: { ...summary.top_item, units_sold: 0 } },
      { ...summary, ad_roi: { spend_npr: -1, revenue_npr: 0 } },
      { ...summary, vendor_id: VENDOR_ID },
    ]) {
      expect(vendorAnalyticsSummarySchema.safeParse(broken).success).toBe(false);
    }
  });
});

describe('notification events (Phase 35)', () => {
  const suspended = envelope('vendor.suspended_for_compliance', VENDOR_ID, {
    vendor_id: VENDOR_ID,
    vendor_phone: '+9779800000011',
    previous_status: 'LIVE',
    suspended_at: AT,
  });
  const ended = envelope('marketing.ad_ended', AD_ID, {
    ad_purchase_id: AD_ID,
    vendor_id: VENDOR_ID,
    vendor_phone: '+9779800000011',
    billing_model: 'PER_ORDER_PREMIUM',
    ends_at: AT,
    returned_npr: 225,
    ended_at: AT,
  });
  const paused = envelope('marketing.ad_paused', AD_ID, {
    ad_purchase_id: AD_ID,
    vendor_id: VENDOR_ID,
    vendor_phone: '+9779800000011',
    reason: 'BUDGET_EXHAUSTED',
    budget_npr: 100,
    amount_paid_npr: 80,
    ends_at: AT,
    paused_at: AT,
  });
  const termsChanged = envelope('marketing.campaign_terms_changed', CAMPAIGN_ID, {
    campaign_id: CAMPAIGN_ID,
    campaign_name: 'Dashain 10%',
    previous_terms_version: 1,
    terms_version: 2,
    voided_vendor_ids: [VENDOR_ID],
    voided_opt_in_count: 1,
    changed_by_user_id: ADMIN_ID,
    changed_at: AT,
  });

  it('are domain events on notifications.broadcast', () => {
    for (const event of [suspended, ended, paused, termsChanged]) {
      expect(domainEventSchema.safeParse(event).success).toBe(true);
      expect(DOMAIN_EVENT_TOPICS[event.event_type as keyof typeof DOMAIN_EVENT_TOPICS]).toBe(
        'notifications.broadcast',
      );
    }
  });

  it('refuse a suspension of a shop that was not LIVE, a foreign phone and an unknown pause reason', () => {
    const broken = [
      { ...suspended, payload: { ...suspended.payload, previous_status: 'APPROVED' } },
      { ...suspended, payload: { ...suspended.payload, vendor_phone: '+15551234567' } },
      { ...paused, payload: { ...paused.payload, reason: 'ADMIN' } },
      { ...ended, payload: { ...ended.payload, returned_npr: -1 } },
      { ...termsChanged, payload: { ...termsChanged.payload, terms_version: 0 } },
      { ...termsChanged, payload: { ...termsChanged.payload, vendor_id: VENDOR_ID } },
    ];
    for (const event of broken) expect(domainEventSchema.safeParse(event).success).toBe(false);
  });

  it('bound how many shops one campaign event names', () => {
    const many = Array.from({ length: MAX_CAMPAIGN_EVENT_VENDORS + 1 }, () => VENDOR_ID);
    expect(
      domainEventSchema.safeParse({
        ...termsChanged,
        payload: { ...termsChanged.payload, voided_vendor_ids: many },
      }).success,
    ).toBe(false);
  });
});
