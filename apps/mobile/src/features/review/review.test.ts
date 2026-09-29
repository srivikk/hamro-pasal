import { mmkvStateStorage } from '../../storage/mmkv-state-storage';
import { createReviewStore, REVIEW_STORE_KEY } from '../../store/useReviewStore';
import type { TrackedOrder } from '../../store/useOrderStore';
import { InMemoryMmkv } from '../../test/in-memory-mmkv';
import { reviewInputSchema, submitReview } from './review-api';
import { orderAwaitingReview } from './review-prompt';

const NOW = Date.parse('2026-09-29T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;

const order = (orderId: string, overrides: Partial<TrackedOrder> = {}): TrackedOrder => ({
  orderId,
  placedAt: NOW - 3 * HOUR,
  deliveredAt: NOW - HOUR,
  state: 'DELIVERED',
  paymentMethod: 'COD',
  totalNpr: 1250,
  ...overrides,
});

describe('review input (shared-types review rules)', () => {
  it.each([0, 6, 2.5])('rejects rating %p', (rating) => {
    expect(reviewInputSchema.safeParse({ order_id: 'o', rating, comment: null }).success).toBe(
      false,
    );
  });

  it('trims the comment and turns a blank one into null', () => {
    expect(
      reviewInputSchema.parse({ order_id: 'o', rating: 5, comment: '  Fresh!  ' }).comment,
    ).toBe('Fresh!');
    expect(
      reviewInputSchema.parse({ order_id: 'o', rating: 5, comment: '   ' }).comment,
    ).toBeNull();
  });

  it('caps the comment at 500 characters', () => {
    expect(
      reviewInputSchema.safeParse({ order_id: 'o', rating: 4, comment: 'x'.repeat(501) }).success,
    ).toBe(false);
  });

  it('is submitted quarantined (double-blind, SPEC §6)', async () => {
    await expect(
      submitReview({ order_id: 'o', rating: 4, comment: null }, { latencyMs: 0 }),
    ).resolves.toMatchObject({ order_id: 'o', is_published: false });
  });
});

describe('orderAwaitingReview', () => {
  const none = { submitted: {}, snoozed: {} };

  it('picks a delivered order inside the 48 h window', () => {
    expect(orderAwaitingReview({ a: order('a') }, none, NOW)?.orderId).toBe('a');
  });

  it('prefers the most recent delivery', () => {
    const orders = { a: order('a', { deliveredAt: NOW - 5 * HOUR }), b: order('b') };

    expect(orderAwaitingReview(orders, none, NOW)?.orderId).toBe('b');
  });

  it.each([
    ['not delivered yet', order('a', { state: 'OUT_FOR_DELIVERY', deliveredAt: null })],
    ['cancelled', order('a', { state: 'CANCELED' })],
    ['delivered more than 48 h ago', order('a', { deliveredAt: NOW - 49 * HOUR })],
    ['delivered at an unknown time', order('a', { deliveredAt: null })],
  ])('skips an order %s', (_label, candidate) => {
    expect(orderAwaitingReview({ a: candidate }, none, NOW)).toBeNull();
  });

  it('skips reviewed and snoozed orders', () => {
    const submitted = {
      a: { reviewId: 'r', rating: 5, comment: null, submittedAt: NOW },
    };

    expect(orderAwaitingReview({ a: order('a') }, { submitted, snoozed: {} }, NOW)).toBeNull();
    expect(
      orderAwaitingReview({ a: order('a') }, { submitted: {}, snoozed: { a: true } }, NOW),
    ).toBeNull();
  });
});

describe('review store', () => {
  it('persists submissions across a relaunch, but not "Not now"', () => {
    const engine = new InMemoryMmkv();
    const store = createReviewStore(mmkvStateStorage(engine));

    store
      .getState()
      .markSubmitted('a', { reviewId: 'r1', rating: 4, comment: 'Fresh', submittedAt: NOW });
    store.getState().snooze('b');

    const relaunched = createReviewStore(mmkvStateStorage(engine));
    expect(relaunched.getState().submitted.a).toEqual({
      reviewId: 'r1',
      rating: 4,
      comment: 'Fresh',
      submittedAt: NOW,
    });
    expect(relaunched.getState().snoozed).toEqual({});
    expect(engine.getString(REVIEW_STORE_KEY)).not.toContain('snoozed');
  });
});
