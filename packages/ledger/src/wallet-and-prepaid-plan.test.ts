import { randomUUID } from 'node:crypto';

import type { Order } from '@hamro-pasal/shared-types';

import { toNpr } from './money';
import {
  planCancellationRefund,
  planOrderFee,
  planPaymentCapture,
  planPaymentReversal,
  planSettlement,
  type PlannedPosting,
} from './settlement-plan';
import { thresholdOf } from './wallet-service';

/*
 * 2026-10-21: the customer wallet routes exactly like a gateway payment (escrow for Model B, the
 * shop's prepaid balance for Model C), and Model C takes its fee at placement.
 */

const vendorId = randomUUID();
const customerId = randomUUID();
const driverId = randomUUID();

type PlanOrder = Parameters<typeof planCancellationRefund>[0];

function order(overrides: Partial<Order> = {}): PlanOrder {
  return {
    id: randomUUID(),
    vendor_id: vendorId,
    customer_id: customerId,
    driver_user_id: null,
    subtotal: 1000,
    delivery_fee: 50,
    platform_commission_amount: 100,
    fulfillment_locked: 'SELF_DELIVERY',
    payment_method: 'WALLET',
    payment_status: 'PAID',
    settlement_model_locked: 'PLATFORM_ESCROW',
    ...overrides,
  };
}

const lines = (postings: readonly PlannedPosting[]) =>
  postings.map((p) => [p.account.type, toNpr(p.amountPaisa)]);
const sum = (postings: readonly PlannedPosting[]) =>
  postings.reduce((t, p) => t + p.amountPaisa, 0);

describe('a wallet payment', () => {
  it('Model B: from the customer wallet into escrow, like a gateway capture', () => {
    const plan = planPaymentCapture(order());
    expect(lines(plan)).toEqual([
      ['CUSTOMER_WALLET', -1050],
      ['SYSTEM_ESCROW', 1050],
    ]);
    expect(plan[0]?.account).toEqual({ type: 'CUSTOMER_WALLET', customerUserId: customerId });
  });

  it('Model C: from the customer wallet straight to the shop, never through escrow', () => {
    const plan = planPaymentCapture(order({ settlement_model_locked: 'DIRECT_PREPAID' }));
    expect(lines(plan)).toEqual([
      ['CUSTOMER_WALLET', -1050],
      ['VENDOR_WALLET', 1050],
    ]);
  });

  it('Model C gateway payment: nothing to post (the shop was paid directly)', () => {
    expect(
      planPaymentCapture(
        order({ payment_method: 'ESEWA', settlement_model_locked: 'DIRECT_PREPAID' }),
      ),
    ).toEqual([]);
  });

  it('a reversal undoes the capture posting for posting', () => {
    const plan = planPaymentReversal(order());
    expect(lines(plan)).toEqual([
      ['CUSTOMER_WALLET', 1050],
      ['SYSTEM_ESCROW', -1050],
    ]);
    expect(sum(plan)).toBe(0);
  });

  it('settles a Model B wallet order exactly like an eSewa one (the hold)', () => {
    expect(lines(planSettlement(order()))).toEqual(
      lines(planSettlement(order({ payment_method: 'ESEWA' }))),
    );
  });

  it('refuses a COD order', () => {
    expect(() => planPaymentCapture(order({ payment_method: 'COD' }))).toThrow('COD');
  });
});

describe('Model C: the fee at placement', () => {
  it('debits the commission from the prepaid balance', () => {
    expect(lines(planOrderFee(order({ settlement_model_locked: 'DIRECT_PREPAID' })))).toEqual([
      ['VENDOR_WALLET', -100],
      ['PLATFORM_REVENUE', 100],
    ]);
  });

  it('is nothing for Model B, or a 0% commission', () => {
    expect(planOrderFee(order())).toEqual([]);
    expect(
      planOrderFee(
        order({ settlement_model_locked: 'DIRECT_PREPAID', platform_commission_amount: 0 }),
      ),
    ).toEqual([]);
  });
});

describe('Model C: settlement at delivery', () => {
  const prepaid = (overrides: Partial<Order> = {}) =>
    order({ settlement_model_locked: 'DIRECT_PREPAID', ...overrides });

  it('own delivery, no campaign: nothing left to move', () => {
    expect(planSettlement(prepaid())).toEqual([]);
    expect(planSettlement(prepaid({ payment_method: 'COD', payment_status: 'PENDING' }))).toEqual(
      [],
    );
  });

  it('fleet: the rider gets the fee the shop collected', () => {
    expect(
      lines(
        planSettlement(prepaid({ fulfillment_locked: 'PLATFORM_FLEET', driver_user_id: driverId })),
      ),
    ).toEqual([
      ['VENDOR_WALLET', -50],
      ['DRIVER_WALLET', 50],
    ]);
  });

  it('cash on a fleet delivery: the rider owes the cash to the shop, less its fee', () => {
    const plan = planSettlement(
      prepaid({
        payment_method: 'COD',
        fulfillment_locked: 'PLATFORM_FLEET',
        driver_user_id: driverId,
      }),
    );
    expect(lines(plan)).toEqual([
      ['DRIVER_WALLET', -1050],
      ['VENDOR_WALLET', 1000],
      ['DRIVER_WALLET', 50],
    ]);
    expect(sum(plan)).toBe(0);
  });

  it('the platform owes the shop its share of a campaign discount', () => {
    const plan = planSettlement(
      prepaid({
        platform_promo_discount_npr: 100,
        platform_promo_vendor_share_npr: 40,
        platform_commission_amount: 96,
      }),
    );
    expect(lines(plan)).toEqual([
      ['VENDOR_WALLET', 60],
      ['PROMO_EXPENSE', -60],
    ]);
  });
});

describe('a cancelled order', () => {
  it('Model B wallet: back to the wallet at once', () => {
    expect(lines(planCancellationRefund(order()))).toEqual([
      ['SYSTEM_ESCROW', -1050],
      ['CUSTOMER_WALLET', 1050],
    ]);
  });

  it('Model B gateway or cash: nothing moves (a gateway refund is owed by hand)', () => {
    expect(planCancellationRefund(order({ payment_method: 'KHALTI' }))).toEqual([]);
    expect(
      planCancellationRefund(order({ payment_method: 'COD', payment_status: 'PENDING' })),
    ).toEqual([]);
  });

  it('Model C wallet: the fee back to the shop, the payment back to the wallet', () => {
    const plan = planCancellationRefund(order({ settlement_model_locked: 'DIRECT_PREPAID' }));
    expect(lines(plan)).toEqual([
      ['PLATFORM_REVENUE', -100],
      ['VENDOR_WALLET', 100],
      ['VENDOR_WALLET', -1050],
      ['CUSTOMER_WALLET', 1050],
    ]);
    expect(sum(plan)).toBe(0);
  });

  it('Model C gateway: the payment the shop received is owed to the customer', () => {
    expect(
      lines(
        planCancellationRefund(
          order({ settlement_model_locked: 'DIRECT_PREPAID', payment_method: 'ESEWA' }),
        ),
      ),
    ).toEqual([
      ['PLATFORM_REVENUE', -100],
      ['VENDOR_WALLET', 100],
      ['VENDOR_WALLET', -1050],
      ['REFUND_CLEARING', 1050],
    ]);
  });

  it('Model C cash: only the fee goes back', () => {
    expect(
      lines(
        planCancellationRefund(
          order({
            settlement_model_locked: 'DIRECT_PREPAID',
            payment_method: 'COD',
            payment_status: 'PENDING',
          }),
        ),
      ),
    ).toEqual([
      ['PLATFORM_REVENUE', -100],
      ['VENDOR_WALLET', 100],
    ]);
  });
});

describe('thresholdOf', () => {
  const thresholds = { limit: -2000, reserve: 5000 };
  it('Models A and B: below the credit limit, back at 0', () => {
    expect(thresholdOf('PLATFORM_ESCROW', thresholds)).toEqual({
      suspendBelow: -2000,
      restoreAt: 0,
    });
    expect(thresholdOf('COD_CREDIT', thresholds)).toEqual({ suspendBelow: -2000, restoreAt: 0 });
  });
  it('Model C: below the Fixed Reserve, back at the reserve', () => {
    expect(thresholdOf('DIRECT_PREPAID', thresholds)).toEqual({
      suspendBelow: 5000,
      restoreAt: 5000,
    });
  });
});
