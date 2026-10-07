import Ionicons from '@expo/vector-icons/Ionicons';
import {
  MAX_REVIEW_FEEDBACK_LENGTH,
  type ReviewSubmitRequest,
  type ReviewView,
} from '@hamro-pasal/shared-types';
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { Modal, Pressable, Text, TextInput, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { ApiError } from '../api/http';
import { existingReviewId, REVIEW_ERROR_CODES, submitReview } from '../api/reviews';
import { formatLocalizedNumber } from '../i18n/format-number';
import { useAuthStore } from '../store/useAuthStore';
import { useReviewStore } from '../store/useReviewStore';
import { useToastStore } from '../store/useToastStore';
import { Button } from './Button';

const STARS = [1, 2, 3, 4, 5] as const;

export interface ReviewModalProps {
  /** The delivered order to review; null hides the modal. */
  orderId: string | null;
  /** Called after a successful submission or "Not now". */
  onDone: () => void;
}

function ReviewForm({ orderId, onDone }: { orderId: string; onDone: () => void }) {
  const { t } = useTranslation();
  const locale = useAuthStore((state) => state.locale);
  const markSubmitted = useReviewStore((state) => state.markSubmitted);
  const snooze = useReviewStore((state) => state.snooze);
  const toast = useToastStore((state) => state.show);
  const [rating, setRating] = useState<number | null>(null);
  const [comment, setComment] = useState('');

  const submit = useMutation<ReviewView, Error, ReviewSubmitRequest>({
    mutationKey: ['review-submit', orderId],
    mutationFn: (input) => submitReview(input),
    onSuccess: (review) => {
      // Recorded only after the server accepted it, so a failed attempt can be retried.
      markSubmitted(orderId, {
        reviewId: review.id,
        rating: review.rating,
        comment: review.feedback,
        submittedAt: Date.now(),
      });
      // PUBLISHED: the vendor had already rated, so the double blind lifted at once (SPEC §6).
      toast(
        t(review.status === 'PUBLISHED' ? 'review.thanksPublished' : 'review.thanks'),
        'success',
      );
      onDone();
    },
    onError: (error, input) => {
      const existing = existingReviewId(error);
      if (existing !== null) {
        // Submitted before (e.g. the response was lost on a flaky network): never ask again.
        markSubmitted(orderId, {
          reviewId: existing,
          rating: input.rating,
          comment: null,
          submittedAt: Date.now(),
        });
        toast(t('review.alreadySubmitted'), 'success');
        onDone();
        return;
      }
      if (
        error instanceof ApiError &&
        (error.code === REVIEW_ERROR_CODES.windowClosed ||
          error.code === REVIEW_ERROR_CODES.notDelivered)
      ) {
        // Retrying cannot succeed: put the prompt away for this session.
        snooze(orderId);
        toast(t('review.unavailable'), 'error');
        onDone();
        return;
      }
      toast(t('review.failed'), 'error');
    },
  });

  return (
    <View className="gap-4 rounded-t-3xl bg-white p-6" testID="review-modal">
      <Text className="text-xl font-bold text-gray-900">{t('review.title')}</Text>

      <View className="flex-row justify-center gap-2" accessibilityRole="radiogroup">
        {STARS.map((star) => {
          const filled = rating !== null && star <= rating;
          return (
            <Pressable
              key={star}
              accessibilityRole="radio"
              accessibilityLabel={t('review.star', { count: star })}
              accessibilityState={{ checked: rating === star }}
              testID={`review-star-${String(star)}`}
              disabled={submit.isPending}
              hitSlop={6}
              onPress={() => {
                setRating(star);
              }}
            >
              <Ionicons name={filled ? 'star' : 'star-outline'} size={40} color="#F59E0B" />
            </Pressable>
          );
        })}
      </View>

      <View>
        <Text className="mb-1 text-sm font-semibold text-gray-700">{t('review.comment')}</Text>
        <TextInput
          testID="review-comment"
          accessibilityLabel={t('review.comment')}
          value={comment}
          onChangeText={setComment}
          placeholder={t('review.commentPlaceholder')}
          maxLength={MAX_REVIEW_FEEDBACK_LENGTH}
          multiline
          editable={!submit.isPending}
          className="min-h-20 rounded-xl border border-gray-300 px-3 py-2 text-gray-900"
        />
        <Text className="mt-1 text-right text-xs text-gray-500">
          {formatLocalizedNumber(comment.length, locale)}/
          {formatLocalizedNumber(MAX_REVIEW_FEEDBACK_LENGTH, locale)}
        </Text>
      </View>

      {/* SPEC §6: double-blind quarantine. */}
      <View className="flex-row gap-2 rounded-xl bg-indigo-50 p-3" testID="review-quarantine">
        <Ionicons name="eye-off-outline" size={20} color="#3730A3" />
        <Text className="flex-1 text-sm font-semibold text-indigo-900">
          {t('review.quarantine')}
        </Text>
      </View>

      <Button
        label={submit.isPending ? t('review.submitting') : t('review.submit')}
        disabled={rating === null || submit.isPending}
        onPress={() => {
          if (rating !== null) submit.mutate({ order_id: orderId, rating, feedback: comment });
        }}
      />
      <Button
        label={t('review.notNow')}
        variant="secondary"
        disabled={submit.isPending}
        onPress={() => {
          snooze(orderId);
          onDone();
        }}
      />
    </View>
  );
}

/** SPEC customer flow step 11: the double-blind review, asked once an order is delivered. */
export function ReviewModal({ orderId, onDone }: ReviewModalProps) {
  return (
    <Modal
      visible={orderId !== null}
      transparent
      animationType="slide"
      onRequestClose={() => {
        if (orderId !== null) useReviewStore.getState().snooze(orderId);
        onDone();
      }}
    >
      <View className="flex-1 justify-end bg-black/40">
        {/* Keyed by order, so each review starts from a blank form. */}
        {orderId === null ? null : <ReviewForm key={orderId} orderId={orderId} onDone={onDone} />}
      </View>
    </Modal>
  );
}
