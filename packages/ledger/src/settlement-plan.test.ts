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

describe('settlement with a platform campaign discount (SPEC core 9)', () => {
  // S 1000, discount 100 of which the vendor bears 50, F 50, C 95 (10% of 950).
  const discounted = (overrides: Partial<Order> = {}) =>
    order({
      platform_promo_discount_npr: 100,
      platform_promo_vendor_share_npr: 50,
      platform_commission_amount: 95,
      ...overrides,
    });
  const byType = (postings: readonly PlannedPosting[]) =>
    postings.map((p) => [p.account.type, toNpr(p.amountPaisa)]);
  const sum = (postings: readonly PlannedPosting[]) =>
    postings.reduce((total, p) => total + p.amountPaisa, 0);

  it('captures what the customer paid: subtotal - discount + delivery', () => {
    expect(byType(planPaymentCapture(discounted()))).toEqual([
      ['GATEWAY_CLEARING', -950],
      ['SYSTEM_ESCROW', 950],
    ]);
  });

  it('prepaid: the vendor earns on what it sold for, and the platform books its share as a cost', () => {
    const plan = planSettlement(discounted());
    expect(byType(plan)).toEqual([
      ['SYSTEM_ESCROW', -950],
      ['VENDOR_WALLET', 905], // 1000 - 50 - 95 + its own 50 delivery fee
      ['PLATFORM_REVENUE', 95],
      ['PROMO_EXPENSE', -50],
    ]);
    expect(sum(plan)).toBe(0);
  });

  it('cash, own delivery: the platform owes the shop its share of the discount, less commission', () => {
    const plan = planSettlement(discounted({ payment_method: 'COD' }));
    expect(byType(plan)).toEqual([
      ['VENDOR_WALLET', -45],
      ['PLATFORM_REVENUE', 95],
      ['PROMO_EXPENSE', -50],
    ]);
    expect(sum(plan)).toBe(0);
  });

  it('cash, fleet: the rider owes what the customer handed over, not the undiscounted total', () => {
    const plan = planSettlement(
      discounted({
        payment_method: 'COD',
        fulfillment_locked: 'PLATFORM_FLEET',
        driver_user_id: driverId,
      }),
    );
    expect(byType(plan)).toEqual([
      ['DRIVER_WALLET', -950],
      ['VENDOR_WALLET', 855],
      ['PLATFORM_REVENUE', 95],
      ['DRIVER_WALLET', 50],
      ['PROMO_EXPENSE', -50],
    ]);
    expect(sum(plan)).toBe(0);
  });

  it('posts no promo line when the vendor bears the whole discount, or the platform all of it', () => {
    const vendorPays = planSettlement(
      discounted({ platform_promo_vendor_share_npr: 100, platform_commission_amount: 90 }),
    );
    expect(byType(vendorPays)).toEqual([
      ['SYSTEM_ESCROW', -950],
      ['VENDOR_WALLET', 860],
      ['PLATFORM_REVENUE', 90],
    ]);
    const platformPays = planSettlement(
      discounted({ platform_promo_vendor_share_npr: 0, platform_commission_amount: 100 }),
    );
    expect(byType(platformPays)).toContainEqual(['PROMO_EXPENSE', -100]);
    expect(byType(platformPays)).toContainEqual(['VENDOR_WALLET', 950]);
    expect(sum(platformPays)).toBe(0);
  });

  it('balances to the paisa for awkward amounts', () => {
    const plan = planSettlement(
      order({
        subtotal: 333.33,
        delivery_fee: 17.77,
        platform_promo_discount_npr: 33.33,
        platform_promo_vendor_share_npr: 11.11,
        platform_commission_amount: 24.17,
      }),
    );
    expect(sum(plan)).toBe(0);
    expect(toPaisa(333.33) - toPaisa(33.33) + toPaisa(17.77)).toBe(
      -(plan.find((p) => p.account.type === 'SYSTEM_ESCROW')?.amountPaisa ?? 0),
    );
  });

  it('refuses a vendor share above the discount and a discount above the goods', () => {
    expect(() => planSettlement(discounted({ platform_promo_vendor_share_npr: 100.01 }))).toThrow(
      SettlementPlanError,
    );
    expect(() => planSettlement(discounted({ platform_promo_discount_npr: 1000.01 }))).toThrow(
      SettlementPlanError,
    );
  });
});
