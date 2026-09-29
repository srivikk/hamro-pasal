import { act, fireEvent, screen } from '@testing-library/react-native';

import { mmkvStateStorage } from '../../storage/mmkv-state-storage';
import { useAuthStore } from '../../store/useAuthStore';
import { useOrderStore } from '../../store/useOrderStore';
import { createReviewStore, useReviewStore } from '../../store/useReviewStore';
import { useToastStore } from '../../store/useToastStore';
import { ORDER_ID } from '../../test/api-fixtures';
import { InMemoryMmkv } from '../../test/in-memory-mmkv';
import { renderWithProviders } from '../../test/render';
import type * as ReviewApi from './review-api';
import { submitReview } from './review-api';
import { ReviewPrompt } from './ReviewPrompt';

jest.mock('./review-api', () => ({
  ...jest.requireActual<typeof ReviewApi>('./review-api'),
  submitReview: jest.fn(),
}));
const mockSubmitReview = jest.mocked(submitReview);

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

async function submit(): Promise<void> {
  await act(async () => {
    fireEvent.press(screen.getByRole('button', { name: 'Submit review' }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  useOrderStore.setState({ orders: {} });
  useReviewStore.setState({ submitted: {}, snoozed: {} });
  useToastStore.setState({ toast: null });
  useAuthStore.getState().setLocale('en');
  mockSubmitReview.mockReset();
  mockSubmitReview.mockImplementation((input) =>
    Promise.resolve({ review_id: 'review-1', order_id: input.order_id, is_published: false }),
  );
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

  it('submits the rating and optional feedback, persists it, and never asks again', async () => {
    deliver();
    renderWithProviders(<ReviewPrompt />);

    fireEvent.press(screen.getByRole('radio', { name: '5 stars' }));
    fireEvent.changeText(
      screen.getByTestId('review-comment'),
      '  Fresh vegetables, quick rider.  ',
    );
    await submit();

    expect(mockSubmitReview).toHaveBeenCalledWith({
      order_id: ORDER_ID,
      rating: 5,
      comment: '  Fresh vegetables, quick rider.  ',
    });
    expect(screen.queryByTestId('review-modal')).toBeNull();
    expect(useReviewStore.getState().submitted[ORDER_ID]).toMatchObject({
      reviewId: 'review-1',
      rating: 5,
      comment: 'Fresh vegetables, quick rider.',
    });
    expect(useToastStore.getState().toast?.message).toBe(
      'Thanks! Your review stays hidden until the vendor rates too, or 48 hours pass.',
    );
  });

  it('does not reappear after a relaunch once submitted', () => {
    const engine = new InMemoryMmkv();
    const store = createReviewStore(mmkvStateStorage(engine));
    store.getState().markSubmitted(ORDER_ID, {
      reviewId: 'review-1',
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

  it('sends a blank feedback as no comment', async () => {
    deliver();
    renderWithProviders(<ReviewPrompt />);

    fireEvent.press(screen.getByRole('radio', { name: '3 stars' }));
    fireEvent.changeText(screen.getByTestId('review-comment'), '   ');
    await submit();

    expect(useReviewStore.getState().submitted[ORDER_ID]?.comment).toBeNull();
  });

  it('keeps the modal and records nothing when submission fails, so it can be retried', async () => {
    mockSubmitReview.mockRejectedValueOnce(new Error('offline'));
    deliver();
    renderWithProviders(<ReviewPrompt />);

    fireEvent.press(screen.getByRole('radio', { name: '2 stars' }));
    await submit();

    expect(screen.getByTestId('review-modal')).toBeOnTheScreen();
    expect(useReviewStore.getState().submitted[ORDER_ID]).toBeUndefined();
    expect(useToastStore.getState().toast?.message).toBe(
      "Couldn't submit your review. Please try again.",
    );

    await submit();
    expect(useReviewStore.getState().submitted[ORDER_ID]?.rating).toBe(2);
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
