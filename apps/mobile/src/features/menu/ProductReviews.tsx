import Ionicons from '@expo/vector-icons/Ionicons';
import {
  MAX_PRODUCT_REVIEW_COMMENT_LENGTH,
  type ProductReviewView,
} from '@hamro-pasal/shared-types';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import {
  fetchProductReviews,
  PRODUCT_REVIEW_ERROR_CODES,
  submitProductReview,
} from '../../api/product-reviews';
import { ApiError } from '../../api/http';
import { retryTransientFailures } from '../../api/query-client';
import { Button } from '../../components/Button';
import { RatingPill } from '../../components/RatingPill';
import { selectHasSession, useAuthStore } from '../../store/useAuthStore';
import { useToastStore } from '../../store/useToastStore';

/** How many reviews the item sheet shows; the rest stay on the server's later pages. */
export const SHEET_REVIEW_COUNT = 3;

export const productReviewsQueryKey = (productId: string) =>
  ['product-reviews', productId] as const;

function Stars({ rating, size = 12 }: { rating: number; size?: number }) {
  return (
    <View className="flex-row">
      {[1, 2, 3, 4, 5].map((value) => (
        <Ionicons
          key={value}
          name={value <= rating ? 'star' : 'star-outline'}
          size={size}
          color="#B45309"
        />
      ))}
    </View>
  );
}

function ReviewRow({ review }: { review: ProductReviewView }) {
  const { t } = useTranslation();
  return (
    <View className="border-t border-gray-100 py-3" testID={`product-review-${review.id}`}>
      <View className="flex-row items-center gap-2">
        <Stars rating={review.rating} />
        <Text className="text-xs font-semibold text-gray-900">
          {review.reviewer_first_name ?? t('productReviews.anonymous')}
        </Text>
        <Text className="text-xs text-green-700">{t('productReviews.verified')}</Text>
      </View>
      {review.comment === null ? null : (
        <Text className="mt-1 text-sm leading-5 text-gray-600">{review.comment}</Text>
      )}
    </View>
  );
}

/** Star picker and comment; starts from the customer's own review when they have one. */
function ReviewForm({
  productId,
  own,
  onDone,
}: {
  productId: string;
  own: ProductReviewView | null;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const showToast = useToastStore((state) => state.show);
  const [rating, setRating] = useState(own?.rating ?? 0);
  const [comment, setComment] = useState(own?.comment ?? '');

  const submit = useMutation({
    mutationFn: () => submitProductReview(productId, { rating, comment }),
    onSuccess: () => {
      showToast(t('productReviews.thanks'), 'info');
      onDone();
    },
    onError: (error) => {
      showToast(
        error instanceof ApiError && error.code === PRODUCT_REVIEW_ERROR_CODES.notVerified
          ? t('productReviews.notVerified')
          : t('productReviews.failed'),
        'error',
      );
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: productReviewsQueryKey(productId) }),
  });

  return (
    <View className="mt-3 rounded-xl bg-gray-50 p-3" testID="product-review-form">
      <View className="flex-row gap-2">
        {[1, 2, 3, 4, 5].map((value) => (
          <Pressable
            key={value}
            accessibilityRole="button"
            accessibilityLabel={t('productReviews.star', { count: value })}
            accessibilityState={{ selected: value === rating }}
            hitSlop={4}
            testID={`product-review-star-${String(value)}`}
            onPress={() => {
              setRating(value);
            }}
          >
            <Ionicons name={value <= rating ? 'star' : 'star-outline'} size={28} color="#B45309" />
          </Pressable>
        ))}
      </View>
      <TextInput
        className="mt-3 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900"
        placeholder={t('productReviews.commentPlaceholder')}
        maxLength={MAX_PRODUCT_REVIEW_COMMENT_LENGTH}
        multiline
        value={comment}
        onChangeText={setComment}
        testID="product-review-comment"
      />
      <View className="mt-3">
        <Button
          label={submit.isPending ? t('productReviews.sending') : t('productReviews.submit')}
          disabled={rating === 0 || submit.isPending}
          testID="product-review-submit"
          onPress={() => {
            submit.mutate();
          }}
        />
      </View>
    </View>
  );
}

/**
 * The reviews part of the item sheet (SPEC core 6, "Ratings and product reviews"): the product's
 * average and count, its newest reviews (first names only, all verified purchases), and, for a
 * signed-in customer whose delivered order held the product, a form to rate it. The server decides
 * who may review (`viewer.can_review`); a refusal is still handled.
 */
export function ProductReviews({ productId }: { productId: string }) {
  const { t } = useTranslation();
  const signedIn = useAuthStore(selectHasSession);
  const [writing, setWriting] = useState(false);

  const query = useQuery({
    // The viewer part differs signed in and out.
    queryKey: [...productReviewsQueryKey(productId), signedIn],
    queryFn: () => fetchProductReviews(productId),
    retry: retryTransientFailures,
  });

  if (query.data === undefined) return null;
  const { summary, reviews, viewer } = query.data;
  const own = viewer?.own_review ?? null;

  return (
    <View className="mt-5" testID="product-reviews">
      <View className="flex-row items-center gap-2">
        <Text className="text-base font-bold text-gray-900">{t('productReviews.title')}</Text>
        {summary.average === null ? null : (
          <RatingPill rating={summary.average} testID="product-reviews-average" />
        )}
        <Text className="text-xs text-gray-500" testID="product-reviews-count">
          {summary.count === 0
            ? t('productReviews.none')
            : t('productReviews.count', { count: summary.count })}
        </Text>
      </View>

      {reviews.slice(0, SHEET_REVIEW_COUNT).map((review) => (
        <ReviewRow key={review.id} review={review} />
      ))}

      {viewer?.can_review === true ? (
        writing ? (
          <ReviewForm
            productId={productId}
            own={own}
            onDone={() => {
              setWriting(false);
            }}
          />
        ) : (
          <View className="mt-2">
            <Button
              variant="secondary"
              size="sm"
              label={own === null ? t('productReviews.write') : t('productReviews.edit')}
              testID="product-review-open"
              onPress={() => {
                setWriting(true);
              }}
            />
          </View>
        )
      ) : null}
    </View>
  );
}
