import { randomUUID } from 'node:crypto';

import { planDisputeRefund, planHoldRelease, splitDispute } from './dispute-hold';
import { toNpr } from './money';
import type { PlannedPosting } from './settlement-plan';

const vendorId = randomUUID();

function describe_(postings: PlannedPosting[]): string[] {
  return postings.map(
    ({ account, amountPaisa, lineType }) =>
      `${account.type}: ${String(toNpr(amountPaisa))} ${String(lineType)}`,
  );
}

function sum(postings: PlannedPosting[]): number {
  return postings.reduce((total, p) => total + p.amountPaisa, 0);
}

describe('splitDispute (step 7.3, SPEC core 6)', () => {
  it('releases everything held when nobody is refunded', () => {
    expect(splitDispute(90_000, 0)).toEqual({
      releasePaisa: 90_000,
      refundFromHoldPaisa: 0,
      refundFromWalletPaisa: 0,
    });
  });

  it('takes a partial refund out of the hold and releases the rest', () => {
    expect(splitDispute(90_000, 30_000)).toEqual({
      releasePaisa: 60_000,
      refundFromHoldPaisa: 30_000,
      refundFromWalletPaisa: 0,
    });
  });

  it('takes the part of a refund the hold cannot cover out of the wallet', () => {
    // A full refund of 1050 against 950 held: the commission part comes from the vendor.
    expect(splitDispute(95_000, 105_000)).toEqual({
      releasePaisa: 0,
      refundFromHoldPaisa: 95_000,
      refundFromWalletPaisa: 10_000,
    });
  });

  it('debits all of a cash refund from the wallet: nothing is held for cash', () => {
    expect(splitDispute(0, 50_000)).toEqual({
      releasePaisa: 0,
      refundFromHoldPaisa: 0,
      refundFromWalletPaisa: 50_000,
    });
  });

  it('refuses fractions and negatives', () => {
    expect(() => splitDispute(-1, 0)).toThrow(RangeError);
    expect(() => splitDispute(100, 0.5)).toThrow(RangeError);
  });
});

describe('the release and refund journals', () => {
  it('moves the release from the hold to the wallet, balanced', () => {
    const postings = planHoldRelease(vendorId, splitDispute(90_000, 30_000));
    expect(describe_(postings)).toEqual([
      'VENDOR_DISPUTE_HOLD: -600 DISPUTE_RELEASE',
      'VENDOR_WALLET: 600 DISPUTE_RELEASE',
    ]);
    expect(sum(postings)).toBe(0);
  });

  it('records the refund as owed to the customer in REFUND_CLEARING, balanced', () => {
    const postings = planDisputeRefund(vendorId, splitDispute(95_000, 105_000));
    expect(describe_(postings)).toEqual([
      'VENDOR_DISPUTE_HOLD: -950 DISPUTE_REFUND',
      'VENDOR_WALLET: -100 DISPUTE_REFUND',
      'REFUND_CLEARING: 1050 DISPUTE_REFUND',
    ]);
    expect(sum(postings)).toBe(0);
  });

  it('plans nothing for nothing to move', () => {
    expect(planHoldRelease(vendorId, splitDispute(0, 0))).toEqual([]);
    expect(planDisputeRefund(vendorId, splitDispute(5_000, 0))).toEqual([]);
  });
});
