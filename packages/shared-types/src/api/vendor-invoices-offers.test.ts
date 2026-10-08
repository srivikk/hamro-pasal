import { AUDIT_ACTION_ENTITY_TYPES } from '../audit/audit-log';
import {
  invoiceAccessActions,
  invoiceCopyLabel,
  vendorInvoiceListQuerySchema,
  vendorInvoiceSummarySchema,
} from './vendor-invoices';
import {
  vendorOfferCreateRequestSchema,
  vendorOfferLabel,
  vendorOfferStatusOf,
  vendorOfferViewSchema,
} from './vendor-offers';
import { taxIdentityResponseSchema } from './vendor-settings';

const ID = '4a1c1d5e-8f0b-4c3a-9b7e-2d6f1a0c5e11';

describe('vendor invoices contract', () => {
  it('names the three logged actions of the documented access log', () => {
    expect(invoiceAccessActions).toEqual(['VIEW', 'DOWNLOAD', 'PRINT']);
  });

  it('marks the first print as the original and every later one as a numbered copy', () => {
    expect(invoiceCopyLabel(0)).toBe('ORIGINAL');
    expect(invoiceCopyLabel(1)).toBe('COPY OF ORIGINAL (1)');
    expect(invoiceCopyLabel(12)).toBe('COPY OF ORIGINAL (12)');
  });

  it('parses the list query: filters, a limit as text, a cursor', () => {
    expect(vendorInvoiceListQuerySchema.parse({})).toEqual({});
    expect(
      vendorInvoiceListQuerySchema.parse({
        fiscal_year: '2082/083',
        document_type: 'INVOICE',
        limit: '50',
        cursor: ID,
      }),
    ).toEqual({ fiscal_year: '2082/083', document_type: 'INVOICE', limit: 50, cursor: ID });
  });

  it.each([
    { fiscal_year: '2082-083' },
    { fiscal_year: '2082/83' },
    { document_type: 'RECEIPT' },
    { limit: '0' },
    { limit: '51' },
    { limit: 'ten' },
    { cursor: 'abc' },
    { vendor_id: ID },
  ])('refuses the query %j', (query) => {
    expect(vendorInvoiceListQuerySchema.safeParse(query).success).toBe(false);
  });

  it('keeps the list entry strict: a header, no seller PAN, lines or customer id', () => {
    const summary = {
      id: ID,
      document_type: 'INVOICE',
      order_id: ID,
      fiscal_year: '2082/083',
      bill_number: 1,
      invoice_sequence: 'HP-2082-000001',
      issued_at: '2025-10-08T06:00:00.000Z',
      issued_date_bs: '2082-06-22',
      buyer_name: 'Customer',
      payment_method: 'COD',
      grand_total_npr: 1180,
      print_count: 0,
    };
    expect(vendorInvoiceSummarySchema.parse(summary)).toEqual(summary);
    expect(vendorInvoiceSummarySchema.safeParse({ ...summary, customer_id: ID }).success).toBe(
      false,
    );
  });

  it('reads a tax identity answer from before the field as "no invoice issued"', () => {
    const before = {
      vendor_id: ID,
      tax_id: '302118845',
      is_vat_registered: false,
      legal_name: null,
      registered_address: null,
      status: 'LIVE',
      compliance_suspension_lifted: false,
      pan_verified_at: null,
    };
    expect(taxIdentityResponseSchema.parse(before).waiting_invoices_issued).toBe(0);
    expect(
      taxIdentityResponseSchema.parse({ ...before, waiting_invoices_issued: 3 })
        .waiting_invoices_issued,
    ).toBe(3);
  });

  it('audits the waiting invoices as a change of the shop', () => {
    expect(AUDIT_ACTION_ENTITY_TYPES.WAITING_INVOICES_ISSUED).toBe('vendor');
  });
});

describe('vendor offers contract', () => {
  it('renders the label customers read from the rule', () => {
    expect(vendorOfferLabel({ kind: 'FLAT', value: 100, max_discount_npr: null })).toBe(
      'Flat Rs. 100 OFF',
    );
    expect(vendorOfferLabel({ kind: 'FLAT', value: 99.5, max_discount_npr: null })).toBe(
      'Flat Rs. 99.50 OFF',
    );
    expect(vendorOfferLabel({ kind: 'PERCENTAGE', value: 10, max_discount_npr: null })).toBe(
      '10% OFF',
    );
    expect(vendorOfferLabel({ kind: 'PERCENTAGE', value: 12.5, max_discount_npr: 100 })).toBe(
      '12.5% OFF up to Rs. 100',
    );
  });

  it('derives the status: cancelled by the shop, ended by its date, otherwise active', () => {
    const now = new Date('2026-10-08T06:00:00.000Z');
    const earlier = new Date('2026-10-08T05:59:59.999Z');
    const later = new Date('2026-10-08T06:00:00.001Z');
    expect(vendorOfferStatusOf({ ended_at: null, ends_at: null }, now)).toBe('ACTIVE');
    expect(vendorOfferStatusOf({ ended_at: null, ends_at: later }, now)).toBe('ACTIVE');
    expect(vendorOfferStatusOf({ ended_at: null, ends_at: now }, now)).toBe('ENDED');
    expect(vendorOfferStatusOf({ ended_at: null, ends_at: earlier }, now)).toBe('ENDED');
    // The shop's own act wins over the date.
    expect(vendorOfferStatusOf({ ended_at: earlier, ends_at: earlier }, now)).toBe('CANCELLED');
    expect(vendorOfferStatusOf({ ended_at: earlier, ends_at: null }, now)).toBe('CANCELLED');
  });

  it('fills the optional terms: no minimum cart, no cap, no end date', () => {
    expect(vendorOfferCreateRequestSchema.parse({ kind: 'PERCENTAGE', value: 10 })).toEqual({
      kind: 'PERCENTAGE',
      value: 10,
      min_cart_npr: 0,
      max_discount_npr: null,
      ends_at: null,
    });
    expect(
      vendorOfferCreateRequestSchema.parse({
        kind: 'FLAT',
        value: 100,
        min_cart_npr: 100,
        ends_at: '2026-11-01T00:00:00.000Z',
      }),
    ).toMatchObject({ kind: 'FLAT', value: 100, min_cart_npr: 100 });
  });

  it.each([
    ['a flat discount above its minimum cart', { kind: 'FLAT', value: 100, min_cart_npr: 99.99 }],
    ['a flat discount with no minimum cart', { kind: 'FLAT', value: 100 }],
    [
      'a cap on a flat discount',
      { kind: 'FLAT', value: 50, min_cart_npr: 500, max_discount_npr: 20 },
    ],
    ['a percentage above 100', { kind: 'PERCENTAGE', value: 100.01 }],
    ['a value of zero', { kind: 'PERCENTAGE', value: 0 }],
    ['a negative minimum cart', { kind: 'PERCENTAGE', value: 10, min_cart_npr: -1 }],
    ['a fraction of a paisa', { kind: 'PERCENTAGE', value: 10, max_discount_npr: 10.001 }],
    ['a cap of zero', { kind: 'PERCENTAGE', value: 10, max_discount_npr: 0 }],
    ['an end that is not an instant', { kind: 'PERCENTAGE', value: 10, ends_at: '2026-11-01' }],
    ['an unknown kind', { kind: 'BOGO', value: 10 }],
    ['a vendor id', { kind: 'PERCENTAGE', value: 10, vendor_id: ID }],
    ['a start date', { kind: 'PERCENTAGE', value: 10, starts_at: '2026-11-01T00:00:00.000Z' }],
    ['a status', { kind: 'PERCENTAGE', value: 10, status: 'ACTIVE' }],
    ['a label', { kind: 'PERCENTAGE', value: 10, label: 'FREE' }],
  ])('refuses %s', (_name, body) => {
    expect(vendorOfferCreateRequestSchema.safeParse(body).success).toBe(false);
  });

  it('keeps the view strict: no vendor or creator id', () => {
    const view = {
      id: ID,
      kind: 'PERCENTAGE',
      value: 10,
      max_discount_npr: null,
      min_cart_npr: 0,
      label: '10% OFF',
      starts_at: '2026-10-08T06:00:00.000Z',
      ends_at: null,
      status: 'ACTIVE',
      created_at: '2026-10-08T06:00:00.000Z',
      ended_at: null,
    };
    expect(vendorOfferViewSchema.parse(view)).toEqual(view);
    expect(vendorOfferViewSchema.safeParse({ ...view, vendor_id: ID }).success).toBe(false);
  });

  it('has the two audited offer actions', () => {
    expect(AUDIT_ACTION_ENTITY_TYPES.VENDOR_OFFER_CREATED).toBe('vendor_offer');
    expect(AUDIT_ACTION_ENTITY_TYPES.VENDOR_OFFER_ENDED).toBe('vendor_offer');
  });
});
