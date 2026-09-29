import { randomUUID } from 'node:crypto';

import type { Order } from '@hamro-pasal/shared-types';

import { toNpr, toPaisa } from './money';
import {
  planPaymentCapture,
  planSettlement,
  SettlementPlanError,
  type PlannedPosting,
} from './settlement-plan';

const vendorId = randomUUID();
const driverId = randomUUID();

type PlanOrder = Parameters<typeof planSettlement>[0];

function order(overrides: Partial<Order> = {}): PlanOrder {
  return {
    id: randomUUID(),
    vendor_id: vendorId,
    driver_user_id: null,
    subtotal: 1000,
    delivery_fee: 50,
    platform_commission_amount: 100,
    fulfillment_locked: 'SELF_DELIVERY',
    payment_method: 'ESEWA',
    ...overrides,
  };
}

/** Renders postings as `ACCOUNT: npr` for readable assertions. */
function describePostings(postings: PlannedPosting[]): string[] {
  return postings.map(
    ({ account, amountPaisa }) => `${account.type}: ${String(toNpr(amountPaisa))}`,
  );
}

const sum = (postings: PlannedPosting[]) => postings.reduce((t, p) => t + p.amountPaisa, 0);

describe('money', () => {
  it('converts NPR to exact integer paisa and back', () => {
    expect(toPaisa(0.1) + toPaisa(0.2)).toBe(toPaisa(0.3));
    expect(toPaisa(902.1)).toBe(90210);
    expect(toNpr(90210)).toBe(902.1);
  });

  it('rejects fractions of a paisa', () => {
    expect(() => toPaisa(1.005)).toThrow(RangeError);
  });
});

describe('planPaymentCapture', () => {
  it('moves the full payment from the gateway clearing account into escrow', () => {
    const postings = planPaymentCapture(order({ payment_method: 'KHALTI' }));

    expect(describePostings(postings)).toEqual(['GATEWAY_CLEARING: -1050', 'SYSTEM_ESCROW: 1050']);
    expect(postings[0]?.account).toEqual({ type: 'GATEWAY_CLEARING', gateway: 'KHALTI' });
  });

  it('refuses COD orders', () => {
    expect(() => planPaymentCapture(order({ payment_method: 'COD' }))).toThrow(SettlementPlanError);
  });
});

describe('planSettlement', () => {
  it('prepaid self-delivery: escrow pays the vendor its share plus the delivery fee', () => {
    const postings = planSettlement(order());

    expect(describePostings(postings)).toEqual([
      'SYSTEM_ESCROW: -1050',
      'VENDOR_WALLET: 950',
      'PLATFORM_REVENUE: 100',
    ]);
    expect(sum(postings)).toBe(0);
  });

  it('prepaid platform fleet: the delivery fee goes to the rider', () => {
    const postings = planSettlement(
      order({ fulfillment_locked: 'PLATFORM_FLEET', driver_user_id: driverId }),
    );

    expect(describePostings(postings)).toEqual([
      'SYSTEM_ESCROW: -1050',
      'VENDOR_WALLET: 900',
      'DRIVER_WALLET: 50',
      'PLATFORM_REVENUE: 100',
    ]);
  });

  it('COD self-delivery: debits the commission from the vendor wallet (SPEC §5)', () => {
    const postings = planSettlement(order({ payment_method: 'COD' }));

    expect(describePostings(postings)).toEqual(['VENDOR_WALLET: -100', 'PLATFORM_REVENUE: 100']);
  });

  it('COD fleet: the rider owes the collected cash minus their fee', () => {
    const postings = planSettlement(
      order({
        payment_method: 'COD',
        fulfillment_locked: 'EMERGENCY_FLEET',
        driver_user_id: driverId,
      }),
    );

    expect(describePostings(postings)).toEqual([
      'DRIVER_WALLET: -1050',
      'VENDOR_WALLET: 900',
      'PLATFORM_REVENUE: 100',
      'DRIVER_WALLET: 50',
    ]);
    expect(sum(postings)).toBe(0);
  });

  it('keeps paisa exact on awkward amounts', () => {
    const postings = planSettlement(
      order({ subtotal: 333.33, delivery_fee: 0.01, platform_commission_amount: 33.33 }),
    );

    expect(describePostings(postings)).toEqual([
      'SYSTEM_ESCROW: -333.34',
      'VENDOR_WALLET: 300.01',
      'PLATFORM_REVENUE: 33.33',
    ]);
    expect(sum(postings)).toBe(0);
  });

  it('drops zero lines: a 0% subscription vendor on COD self-delivery has nothing to post', () => {
    expect(planSettlement(order({ payment_method: 'COD', platform_commission_amount: 0 }))).toEqual(
      [],
    );
  });

  it('rejects fleet orders without a driver and commission above subtotal', () => {
    expect(() => planSettlement(order({ fulfillment_locked: 'PLATFORM_FLEET' }))).toThrow(
      'no driver',
    );
    expect(() => planSettlement(order({ platform_commission_amount: 1000.01 }))).toThrow(
      'exceeds its subtotal',
    );
  });
});
