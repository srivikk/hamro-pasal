import type { AdminProductReviewView } from '@hamro-pasal/shared-types';

import { ApiError } from '../api/client';
import { fakeAdminApi } from '../api/fake-admin-api';
import { checkHideReason, reviewErrorMessage, stars, statusOf } from './reviews/review-rules';

const REVIEW: AdminProductReviewView = {
  id: '44444444-4444-4444-8444-444444444444',
  product_id: '55555555-5555-4555-8555-555555555555',
  rating: 2,
  comment: 'Call me on 98XXXXXXXX for a better deal',
  reviewer_first_name: 'Sita',
  verified_purchase: true,
  created_at: '2026-10-21T06:00:00.000Z',
  updated_at: '2026-10-21T06:00:00.000Z',
  product_name: 'Ilam Tea 500g',
  vendor: { id: '66666666-6666-4666-8666-666666666666', business_name: 'Thamel Kirana' },
  hidden: false,
  hidden_at: null,
  hidden_reason: null,
};

describe('product review moderation rules (2026-10-22)', () => {
  it('maps the filter chips to the API status', () => {
    expect([statusOf('ALL'), statusOf('VISIBLE'), statusOf('HIDDEN')]).toEqual([
      undefined,
      'VISIBLE',
      'HIDDEN',
    ]);
  });

  it('draws stars, clamped to 0..5', () => {
    expect(stars(3)).toBe('★★★☆☆');
    expect(stars(5)).toBe('★★★★★');
    expect(stars(9)).toBe('★★★★★');
  });

  it('needs a reason of 10 to 300 characters, trimmed', () => {
    expect(checkHideReason('  Shares a phone number.  ')).toEqual({
      ok: true,
      reason: 'Shares a phone number.',
    });
    expect(checkHideReason('spam').ok).toBe(false);
    expect(checkHideReason('x'.repeat(301)).ok).toBe(false);
  });

  it('words the refusals', () => {
    expect(reviewErrorMessage(new ApiError(404, 'PRODUCT_REVIEW_NOT_FOUND', 'x'))).toBe(
      'That review no longer exists.',
    );
    expect(reviewErrorMessage(new Error('boom'))).toBe('Something went wrong. Try again.');
  });

  it('calls the two admin routes with the documented bodies', async () => {
    const { calls, api } = fakeAdminApi((call) =>
      call.startsWith('GET')
        ? { body: { reviews: [REVIEW], next_cursor: null } }
        : {
            body: {
              review: {
                ...REVIEW,
                hidden: true,
                hidden_at: REVIEW.created_at,
                hidden_reason: 'Spam link inside.',
              },
            },
          },
    );
    const page = await api.listProductReviews({ status: 'HIDDEN' });
    expect(page.reviews).toHaveLength(1);
    await api.moderateProductReview(REVIEW.id, { hidden: true, reason: 'Spam link inside.' });
    await api.moderateProductReview(REVIEW.id, { hidden: false });
    expect(calls.map(({ call, body }) => ({ call, body }))).toEqual([
      { call: 'GET /api/admin/product-reviews?status=HIDDEN', body: undefined },
      {
        call: `PATCH /api/admin/product-reviews/${REVIEW.id}`,
        body: { hidden: true, reason: 'Spam link inside.' },
      },
      { call: `PATCH /api/admin/product-reviews/${REVIEW.id}`, body: { hidden: false } },
    ]);
  });
});
