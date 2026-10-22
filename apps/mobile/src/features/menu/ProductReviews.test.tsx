import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import { http, HttpResponse } from 'msw';

import { productReviewsPath } from '../../api/product-reviews';
import { useAuthStore } from '../../store/useAuthStore';
import { useToastStore } from '../../store/useToastStore';
import { apiUrl, server, setupApiTestEnvironment, TEST_ACCESS_TOKEN } from '../../test/msw';
import { renderWithProviders } from '../../test/render';
import { ProductReviews, SHEET_REVIEW_COUNT } from './ProductReviews';

setupApiTestEnvironment();

const PRODUCT_ID = '0a8f1c2e-0000-4000-8000-0000000000b1';
const NOW = '2026-10-21T08:00:00.000Z';

function review(n: number, overrides: Record<string, unknown> = {}) {
  return {
    id: `0a8f1c2e-0000-4000-8000-0000000001${String(n).padStart(2, '0')}`,
    product_id: PRODUCT_ID,
    rating: 4,
    comment: `Comment ${String(n)}`,
    reviewer_first_name: `Reviewer${String(n)}`,
    verified_purchase: true,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

function serve(body: Record<string, unknown>) {
  const seen: (string | null)[] = [];
  server.use(
    http.get(apiUrl(productReviewsPath(PRODUCT_ID)), ({ request }) => {
      seen.push(request.headers.get('authorization'));
      return HttpResponse.json({ next_cursor: null, ...body });
    }),
  );
  return seen;
}

const toast = () => useToastStore.getState().toast;

describe('ProductReviews (item sheet)', () => {
  it('shows the average, the count and the newest reviews, verified, by first name', async () => {
    const reviews = [1, 2, 3, 4].map((n) => review(n));
    const auth = serve({ summary: { average: 4.3, count: 12 }, reviews, viewer: null });
    renderWithProviders(<ProductReviews productId={PRODUCT_ID} />);

    expect(await screen.findByTestId('product-reviews-count')).toHaveTextContent('12 reviews');
    expect(screen.getByTestId('product-reviews-average')).toBeTruthy();
    for (const r of reviews.slice(0, SHEET_REVIEW_COUNT)) {
      expect(screen.getByTestId(`product-review-${r.id}`)).toHaveTextContent(
        `${r.reviewer_first_name}Verified purchase${r.comment}`,
      );
    }
    expect(screen.queryByTestId(`product-review-${reviews[3]?.id ?? ''}`)).toBeNull();
    // A signed-in customer's token travels with the read, so the server can say "can_review".
    expect(auth[0]).toBe(`Bearer ${TEST_ACCESS_TOKEN}`);
    // Not a verified purchaser: no way to write.
    expect(screen.queryByTestId('product-review-open')).toBeNull();
  });

  it('reads publicly for a guest, without a token', async () => {
    useAuthStore.getState().clearSession();
    const auth = serve({ summary: { average: null, count: 0 }, reviews: [], viewer: null });
    renderWithProviders(<ProductReviews productId={PRODUCT_ID} />);
    expect(await screen.findByTestId('product-reviews-count')).toHaveTextContent('No reviews yet');
    expect(screen.queryByTestId('product-reviews-average')).toBeNull();
    expect(auth[0]).toBeNull();
  });

  it('lets a verified purchaser rate the product, then refreshes the list', async () => {
    let posted: unknown = null;
    let reads = 0;
    server.use(
      http.get(apiUrl(productReviewsPath(PRODUCT_ID)), () => {
        reads += 1;
        return HttpResponse.json({
          summary: { average: null, count: 0 },
          reviews: [],
          next_cursor: null,
          viewer: { can_review: true, own_review: null },
        });
      }),
      http.post(apiUrl(productReviewsPath(PRODUCT_ID)), async ({ request }) => {
        posted = await request.json();
        return HttpResponse.json({ review: review(9, { rating: 5 }) }, { status: 201 });
      }),
    );
    renderWithProviders(<ProductReviews productId={PRODUCT_ID} />);

    fireEvent.press(await screen.findByTestId('product-review-open'));
    // Nothing to send until a star is chosen.
    expect(screen.getByTestId('product-review-submit')).toBeDisabled();
    fireEvent.press(screen.getByTestId('product-review-star-5'));
    fireEvent.changeText(screen.getByTestId('product-review-comment'), '  Fresh and well packed. ');
    fireEvent.press(screen.getByTestId('product-review-submit'));

    await waitFor(() => {
      expect(toast()?.message).toBe('Thanks for your review.');
    });
    expect(posted).toEqual({ rating: 5, comment: 'Fresh and well packed.' });
    expect(screen.queryByTestId('product-review-form')).toBeNull();
    await waitFor(() => {
      expect(reads).toBe(2);
    });
  });

  it('opens the form on the customer’s own review, and words a refused purchase', async () => {
    serve({
      summary: { average: 3, count: 1 },
      reviews: [review(1, { rating: 3 })],
      viewer: { can_review: true, own_review: review(1, { rating: 3, comment: 'Okay' }) },
    });
    server.use(
      http.post(apiUrl(productReviewsPath(PRODUCT_ID)), () =>
        HttpResponse.json(
          { error: { code: 'NOT_A_VERIFIED_PURCHASE', message: 'No delivered order' } },
          { status: 403 },
        ),
      ),
    );
    renderWithProviders(<ProductReviews productId={PRODUCT_ID} />);

    const open = await screen.findByTestId('product-review-open');
    expect(open).toHaveTextContent('Edit your review');
    fireEvent.press(open);
    expect(screen.getByTestId('product-review-comment').props.value).toBe('Okay');
    expect(screen.getByTestId('product-review-submit')).toBeEnabled();
    fireEvent.press(screen.getByTestId('product-review-submit'));

    await waitFor(() => {
      expect(toast()?.message).toBe(
        'You can review a product once an order with it has been delivered to you.',
      );
    });
    // The form stays open with what was typed.
    expect(screen.getByTestId('product-review-form')).toBeTruthy();
  });
});
