import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { http, HttpResponse } from 'msw';

import { REVIEWS_PATH } from '../../api/reviews';
import { mmkvStateStorage } from '../../storage/mmkv-state-storage';
import { useAuthStore } from '../../store/useAuthStore';
import { useOrderStore } from '../../store/useOrderStore';
import { createReviewStore, useReviewStore } from '../../store/useReviewStore';
import { useToastStore } from '../../store/useToastStore';
import { errorBody, ORDER_ID, REVIEW_ID, reviewResponse } from '../../test/api-fixtures';
import { InMemoryMmkv } from '../../test/in-memory-mmkv';
import {
  apiUrl,
  capture,
  server,
  setupApiTestEnvironment,
  TEST_ACCESS_TOKEN,
  type CapturedRequest,
} from '../../test/msw';
import { renderWithProviders } from '../../test/render';
import { ReviewPrompt } from './ReviewPrompt';

setupApiTestEnvironment();

const HOUR = 60 * 60 * 1000;
const QUARANTINE = 'Reviews remain hidden until both customer and vendor rate, or 48 hours elapse.';

function deliver(orderId = ORDER_ID, deliveredAgo = HOUR): void {
  useOrderStore.setState({
    orders: {
      [orderId]: {
        orderId,
        placedAt: Date.now() - deliveredAgo - HOUR,
        deliveredAt: Date.now() - deliveredAgo,
        state: 'DELIVERED',
        paymentMethod: 'COD',
        totalNpr: 1250,
      },
    },
  });
}

/** Serves POST /api/reviews with `respond`, recording every request it receives. */
function serveReviews(respond: (body: unknown) => Response | Promise<Response>) {
  const requests: CapturedRequest[] = [];
  server.use(
    http.post(apiUrl(REVIEWS_PATH), async ({ request }) => {
      const captured = await capture(request);
      requests.push(captured);
      return respond(captured.body);
    }),
  );
  return requests;
}

/** Answers like the real API: the stored review echoes the (server-trimmed) input. */
function acceptReview(status: 'QUARANTINED' | 'PUBLISHED' = 'QUARANTINED') {
  return serveReviews((body) => {
    const input = body as { rating: number; feedback: string | null };
    return HttpResponse.json(
      reviewResponse({
        rating: input.rating,
        feedback: input.feedback,
        status,
        published_at: status === 'PUBLISHED' ? '2026-09-30T09:00:00.000Z' : null,
      }),
      { status: 201 },
    );
  });
}

function submit(): void {
  fireEvent.press(screen.getByRole('button', { name: 'Submit review' }));
}

const toastMessage = () => useToastStore.getState().toast?.message;

beforeEach(() => {
  useOrderStore.setState({ orders: {} });
  useReviewStore.setState({ submitted: {}, snoozed: {} });
  useToastStore.setState({ toast: null });
  useAuthStore.getState().setLocale('en');
});

describe('post-delivery review lifecycle', () => {
  it('opens by itself once an order is delivered, with the quarantine badge', () => {
    renderWithProviders(<ReviewPrompt />);
    expect(screen.queryByTestId('review-modal')).toBeNull();

    act(() => {
      deliver();
    });

    expect(screen.getByTestId('review-modal')).toBeOnTheScreen();
    expect(screen.getByTestId('review-quarantine')).toHaveTextContent(QUARANTINE);
  });

  it('needs a star rating before it can be submitted', () => {
    deliver();
    renderWithProviders(<ReviewPrompt />);

    expect(screen.getByRole('button', { name: 'Submit review' })).toBeDisabled();
    fireEvent.press(screen.getByRole('radio', { name: '4 stars' }));
    expect(screen.getByRole('button', { name: 'Submit review' })).toBeEnabled();
    expect(screen.getByRole('radio', { name: '4 stars' })).toBeChecked();
  });

  it('posts the rating and feedback to /api/reviews and records the quarantined review', async () => {
    const requests = acceptReview();
    deliver();
    renderWithProviders(<ReviewPrompt />);

    fireEvent.press(screen.getByRole('radio', { name: '5 stars' }));
    fireEvent.changeText(
      screen.getByTestId('review-comment'),
      '  Fresh vegetables, quick rider.  ',
    );
    submit();

    await waitFor(() => {
      expect(screen.queryByTestId('review-modal')).toBeNull();
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.headers.get('authorization')).toBe(`Bearer ${TEST_ACCESS_TOKEN}`);
    expect(requests[0]?.body).toEqual({
      order_id: ORDER_ID,
      rating: 5,
      feedback: 'Fresh vegetables, quick rider.',
    });
    expect(useReviewStore.getState().submitted[ORDER_ID]).toMatchObject({
      reviewId: REVIEW_ID,
      rating: 5,
      comment: 'Fresh vegetables, quick rider.',
    });
    expect(toastMessage()).toBe(
      'Thanks! Your review stays hidden until the vendor rates too, or 48 hours pass.',
    );
  });

  it('tells the customer when both reviews went public at once (vendor had rated)', async () => {
    acceptReview('PUBLISHED');
    deliver();
    renderWithProviders(<ReviewPrompt />);

    fireEvent.press(screen.getByRole('radio', { name: '4 stars' }));
    submit();

    await waitFor(() => {
      expect(toastMessage()).toBe(
        'Thanks! The vendor has rated too, so both reviews are now visible.',
      );
    });
    expect(useReviewStore.getState().submitted[ORDER_ID]?.reviewId).toBe(REVIEW_ID);
  });

  it('sends blank feedback as null', async () => {
    const requests = acceptReview();
    deliver();
    renderWithProviders(<ReviewPrompt />);

    fireEvent.press(screen.getByRole('radio', { name: '3 stars' }));
    fireEvent.changeText(screen.getByTestId('review-comment'), '   ');
    submit();

    await waitFor(() => {
      expect(useReviewStore.getState().submitted[ORDER_ID]).toBeDefined();
    });
    expect(requests[0]?.body).toEqual({ order_id: ORDER_ID, rating: 3, feedback: null });
    expect(useReviewStore.getState().submitted[ORDER_ID]?.comment).toBeNull();
  });

  it('keeps the modal and records nothing when the server fails, so it can be retried', async () => {
    let calls = 0;
    serveReviews(() => {
      calls += 1;
      return calls === 1
        ? HttpResponse.json(errorBody('INTERNAL_SERVER_ERROR'), { status: 500 })
        : HttpResponse.json(reviewResponse({ rating: 2 }), { status: 201 });
    });
    deliver();
    renderWithProviders(<ReviewPrompt />);

    fireEvent.press(screen.getByRole('radio', { name: '2 stars' }));
    submit();

    await waitFor(() => {
      expect(toastMessage()).toBe("Couldn't submit your review. Please try again.");
    });
    expect(screen.getByTestId('review-modal')).toBeOnTheScreen();
    expect(useReviewStore.getState().submitted[ORDER_ID]).toBeUndefined();

    submit();
    await waitFor(() => {
      expect(useReviewStore.getState().submitted[ORDER_ID]?.rating).toBe(2);
    });
  });

  it('keeps the modal when the network is down', async () => {
    serveReviews(() => HttpResponse.error());
    deliver();
    renderWithProviders(<ReviewPrompt />);

    fireEvent.press(screen.getByRole('radio', { name: '5 stars' }));
    submit();

    await waitFor(() => {
      expect(toastMessage()).toBe("Couldn't submit your review. Please try again.");
    });
    expect(screen.getByTestId('review-modal')).toBeOnTheScreen();
  });

  it('treats 409 REVIEW_ALREADY_SUBMITTED as done (a lost response), never asking again', async () => {
    const existing = '11111111-2222-4333-8444-555555555555';
    serveReviews(() =>
      HttpResponse.json(errorBody('REVIEW_ALREADY_SUBMITTED', { review_id: existing }), {
        status: 409,
      }),
    );
    deliver();
    renderWithProviders(<ReviewPrompt />);

    fireEvent.press(screen.getByRole('radio', { name: '4 stars' }));
    submit();

    await waitFor(() => {
      expect(screen.queryByTestId('review-modal')).toBeNull();
    });
    expect(useReviewStore.getState().submitted[ORDER_ID]?.reviewId).toBe(existing);
    expect(toastMessage()).toBe("You've already reviewed this order.");
  });

  it.each([
    ['422 REVIEW_WINDOW_CLOSED', 'REVIEW_WINDOW_CLOSED', 422],
    ['409 ORDER_STATE_CONFLICT', 'ORDER_STATE_CONFLICT', 409],
  ])('puts the prompt away on %s', async (_label, code, status) => {
    serveReviews(() => HttpResponse.json(errorBody(code), { status }));
    deliver();
    renderWithProviders(<ReviewPrompt />);

    fireEvent.press(screen.getByRole('radio', { name: '4 stars' }));
    submit();

    await waitFor(() => {
      expect(screen.queryByTestId('review-modal')).toBeNull();
    });
    expect(useReviewStore.getState().submitted[ORDER_ID]).toBeUndefined();
    expect(useReviewStore.getState().snoozed[ORDER_ID]).toBe(true);
    expect(toastMessage()).toBe('This order can no longer be reviewed.');
  });

  it('does not reappear after a relaunch once submitted', () => {
    const engine = new InMemoryMmkv();
    const store = createReviewStore(mmkvStateStorage(engine));
    store.getState().markSubmitted(ORDER_ID, {
      reviewId: REVIEW_ID,
      rating: 4,
      comment: null,
      submittedAt: Date.now(),
    });
    // The relaunched app hydrates from the same MMKV file.
    useReviewStore.setState({
      submitted: createReviewStore(mmkvStateStorage(engine)).getState().submitted,
    });
    deliver();

    renderWithProviders(<ReviewPrompt />);

    expect(screen.queryByTestId('review-modal')).toBeNull();
  });

  it('"Not now" hides it for this session only', () => {
    deliver();
    renderWithProviders(<ReviewPrompt />);

    fireEvent.press(screen.getByRole('button', { name: 'Not now' }));

    expect(screen.queryByTestId('review-modal')).toBeNull();
    expect(useReviewStore.getState().submitted[ORDER_ID]).toBeUndefined();
    expect(useReviewStore.getState().snoozed[ORDER_ID]).toBe(true);
  });

  it('is not asked more than 48 h after delivery', () => {
    deliver(ORDER_ID, 49 * HOUR);
    renderWithProviders(<ReviewPrompt />);

    expect(screen.queryByTestId('review-modal')).toBeNull();
  });

  it('explains the quarantine in Nepali', () => {
    useAuthStore.getState().setLocale('ne');
    deliver();
    renderWithProviders(<ReviewPrompt />, { locale: 'ne' });

    expect(screen.getByTestId('review-quarantine')).toHaveTextContent(
      'ग्राहक र विक्रेता दुवैले मूल्याङ्कन नगरेसम्म वा ४८ घण्टा नबितेसम्म समीक्षाहरू लुकाइन्छन्।',
    );
    expect(screen.getByRole('radio', { name: '५ तारा' })).toBeOnTheScreen();
  });
});
