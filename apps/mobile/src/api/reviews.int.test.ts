import { http, HttpResponse } from 'msw';

import { errorBody, ORDER_ID, REVIEW_ID, reviewResponse } from '../test/api-fixtures';
import {
  apiUrl,
  capture,
  server,
  setupApiTestEnvironment,
  TEST_ACCESS_TOKEN,
  type CapturedRequest,
} from '../test/msw';
import { ApiError, CLIENT_ERROR_CODES } from './http';
import { existingReviewId, REVIEW_ERROR_CODES, REVIEWS_PATH, submitReview } from './reviews';

setupApiTestEnvironment();

describe('POST /api/reviews', () => {
  it('sends order_id, rating and trimmed feedback with the Bearer token', async () => {
    const received: CapturedRequest[] = [];
    server.use(
      http.post(apiUrl(REVIEWS_PATH), async ({ request }) => {
        received.push(await capture(request));
        return HttpResponse.json(reviewResponse({ rating: 4, feedback: 'Fresh saag.' }), {
          status: 201,
        });
      }),
    );

    const review = await submitReview({
      order_id: ORDER_ID,
      rating: 4,
      feedback: '  Fresh saag.  ',
    });

    expect(received[0]?.headers.get('authorization')).toBe(`Bearer ${TEST_ACCESS_TOKEN}`);
    expect(received[0]?.headers.get('content-type')).toBe('application/json');
    expect(received[0]?.body).toEqual({ order_id: ORDER_ID, rating: 4, feedback: 'Fresh saag.' });
    expect(review).toEqual(reviewResponse({ rating: 4, feedback: 'Fresh saag.' }).review);
    expect(review.status).toBe('QUARANTINED');
  });

  it('refuses input that breaks the contract without sending anything', async () => {
    // msw answers any unhandled request with an error, so a request here would fail differently.
    await expect(submitReview({ order_id: ORDER_ID, rating: 6 })).rejects.toMatchObject({
      code: REVIEW_ERROR_CODES.invalid,
    });
    await expect(submitReview({ order_id: 'not-a-uuid', rating: 5 })).rejects.toMatchObject({
      code: REVIEW_ERROR_CODES.invalid,
    });
  });

  it('surfaces the server codes the modal branches on', async () => {
    server.use(
      http.post(apiUrl(REVIEWS_PATH), () =>
        HttpResponse.json(errorBody('REVIEW_ALREADY_SUBMITTED', { review_id: REVIEW_ID }), {
          status: 409,
        }),
      ),
    );

    const error = await submitReview({ order_id: ORDER_ID, rating: 5 }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 409, code: 'REVIEW_ALREADY_SUBMITTED' });
    expect(existingReviewId(error)).toBe(REVIEW_ID);
    expect(existingReviewId(new ApiError(409, 'ORDER_STATE_CONFLICT', ''))).toBeNull();
  });

  it('rejects a response that breaks the review contract', async () => {
    server.use(
      http.post(apiUrl(REVIEWS_PATH), () =>
        HttpResponse.json(
          { review: { ...reviewResponse().review, status: 'HIDDEN' } },
          { status: 201 },
        ),
      ),
    );

    await expect(submitReview({ order_id: ORDER_ID, rating: 5 })).rejects.toMatchObject({
      code: CLIENT_ERROR_CODES.badResponse,
    });
  });
});
