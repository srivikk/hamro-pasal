import { ledgerEntrySchema } from '../domain/entities';
import {
  adLedgerLineTypes,
  ledgerAccountTypes,
  ledgerLineTypes,
  ledgerTransactionKinds,
} from '../domain/enums';
import { AUDIT_ACTION_ENTITY_TYPES } from '../audit/audit-log';
import { walletEntryTypes } from './responses';
import {
  adPurchaseRequestSchema,
  adPurchaseViewSchema,
  vendorAdProductListResponseSchema,
} from './vendor-ads';

const ID = '4a1c1d5e-8f0b-4c3a-9b7e-2d6f1a0c5e11';
const request = {
  ad_product_id: ID,
  starts_at: '2026-10-09T00:00:00.000Z',
  idempotency_key: 'purchase-0001',
  agreed: true,
};

describe('ledger lines and accounts for ads', () => {
  it('has the two ad charge lines, apart from commission', () => {
    expect(ledgerLineTypes).toEqual(expect.arrayContaining(['AD_FLAT_FEE', 'AD_ORDER_PREMIUM']));
    expect(ledgerLineTypes).toContain('PLATFORM_COMMISSION');
    for (const line of adLedgerLineTypes) expect(line.startsWith('AD_')).toBe(true);
  });

  it('has the ad revenue account and the ad journals', () => {
    expect(ledgerAccountTypes).toEqual(
      expect.arrayContaining(['AD_REVENUE', 'AD_BUDGET_CLEARING', 'PLATFORM_REVENUE']),
    );
    expect(ledgerTransactionKinds).toEqual(
      expect.arrayContaining(['AD_PURCHASE', 'AD_BUDGET_RELEASE', 'AD_REFUND']),
    );
    expect(walletEntryTypes).toEqual(expect.arrayContaining(['AD_CHARGE', 'AD_REFUND']));
  });

  it('carries the line type and the purchase on every ledger entry', () => {
    const entry = {
      id: ID,
      transaction_id: ID,
      account_id: ID,
      amount_npr: -1000,
      created_at: new Date(),
      line_type: 'AD_FLAT_FEE',
      ad_purchase_id: ID,
    };
    expect(ledgerEntrySchema.safeParse(entry).success).toBe(true);
    expect(ledgerEntrySchema.safeParse({ ...entry, line_type: 'AD_SOMETHING' }).success).toBe(
      false,
    );
    const { line_type: _line, ...withoutLine } = entry;
    expect(ledgerEntrySchema.safeParse(withoutLine).success).toBe(false);
  });

  it('audits a purchase and a cancellation as ad purchase records', () => {
    expect(AUDIT_ACTION_ENTITY_TYPES.AD_PURCHASED).toBe('ad_purchase');
    expect(AUDIT_ACTION_ENTITY_TYPES.AD_CANCELLED).toBe('ad_purchase');
  });
});

describe('adPurchaseRequestSchema', () => {
  it('accepts a flat-rate purchase, and a per-order one with its budget', () => {
    expect(adPurchaseRequestSchema.safeParse(request).success).toBe(true);
    expect(adPurchaseRequestSchema.safeParse({ ...request, budget_npr: 500.5 }).success).toBe(true);
    expect(adPurchaseRequestSchema.safeParse({ ...request, budget_npr: null }).success).toBe(true);
  });

  it('needs the explicit agreement', () => {
    const { agreed: _agreed, ...unagreed } = request;
    expect(adPurchaseRequestSchema.safeParse(unagreed).success).toBe(false);
    expect(adPurchaseRequestSchema.safeParse({ ...request, agreed: false }).success).toBe(false);
    expect(adPurchaseRequestSchema.safeParse({ ...request, agreed: 'true' }).success).toBe(false);
  });

  it('names no vendor, price or billing model', () => {
    for (const extra of [{ vendor_id: ID }, { price_npr: 1 }, { billing_model: 'FLAT_RATE' }]) {
      expect(adPurchaseRequestSchema.safeParse({ ...request, ...extra }).success).toBe(false);
    }
  });

  it('refuses a budget that is not a positive amount in whole paisa', () => {
    for (const budget of [0, -5, 10.005, 1_000_000.01, '500']) {
      expect(adPurchaseRequestSchema.safeParse({ ...request, budget_npr: budget }).success).toBe(
        false,
      );
    }
  });

  it('refuses a short key and a start that is not an instant', () => {
    expect(
      adPurchaseRequestSchema.safeParse({ ...request, idempotency_key: 'short' }).success,
    ).toBe(false);
    expect(adPurchaseRequestSchema.safeParse({ ...request, starts_at: '2026-10-09' }).success).toBe(
      false,
    );
  });
});

describe('vendor ad views', () => {
  const purchase = {
    id: ID,
    ad_product_id: ID,
    product_name: 'Carousel Placement',
    slot: 'CAROUSEL',
    billing_model: 'FLAT_RATE',
    price_npr: 5000,
    budget_npr: null,
    settlement_model: 'PLATFORM_ESCROW',
    status: 'ACTIVE',
    starts_at: '2026-10-09T00:00:00.000Z',
    ends_at: '2026-10-16T00:00:00.000Z',
    amount_paid_npr: 1000,
    amount_due_npr: 4000,
    agreed_at: '2026-10-08T10:00:00.000Z',
  };

  it('shows a purchase without the account that agreed or its key', () => {
    expect(adPurchaseViewSchema.safeParse(purchase).success).toBe(true);
    expect(adPurchaseViewSchema.safeParse({ ...purchase, agreed_by_user_id: ID }).success).toBe(
      false,
    );
    expect(adPurchaseViewSchema.safeParse({ ...purchase, idempotency_key: 'k' }).success).toBe(
      false,
    );
  });

  it('never reports negative funds', () => {
    const market = { settlement_model: 'COD_CREDIT', available_for_ads_npr: 0, products: [] };
    expect(vendorAdProductListResponseSchema.safeParse(market).success).toBe(true);
    expect(
      vendorAdProductListResponseSchema.safeParse({ ...market, available_for_ads_npr: -1 }).success,
    ).toBe(false);
  });
});
