import { z } from 'zod';
import { create, type Mutate, type StoreApi, type UseBoundStore } from 'zustand';
import { createJSONStorage, persist, type StateStorage } from 'zustand/middleware';

import { getAppStorage } from '../storage/app-mmkv';
import { mmkvStateStorage } from '../storage/mmkv-state-storage';

export const REVIEW_STORE_KEY = 'hamro-pasal.reviews';
export const REVIEW_STORE_VERSION = 1;

const submittedReviewSchema = z.strictObject({
  reviewId: z.string().min(1),
  rating: z.number().int().min(1).max(5),
  comment: z.string().nullable(),
  submittedAt: z.number().int().nonnegative(),
});

const persistedReviewsSchema = z.strictObject({
  submitted: z.record(z.string(), submittedReviewSchema),
});

export type SubmittedReviewRecord = z.infer<typeof submittedReviewSchema>;

export interface ReviewStoreState {
  /** Reviews this device has submitted, by order id. Persisted: the prompt never returns for them. */
  submitted: Record<string, SubmittedReviewRecord>;
  /** Orders whose prompt was put off ("Not now") in this app session. Memory only. */
  snoozed: Record<string, true>;
  markSubmitted: (orderId: string, review: SubmittedReviewRecord) => void;
  snooze: (orderId: string) => void;
}

export type PersistedReviewState = Pick<ReviewStoreState, 'submitted'>;

export type ReviewStore = UseBoundStore<
  Mutate<StoreApi<ReviewStoreState>, [['zustand/persist', PersistedReviewState]]>
>;

function toPersistedReviews(value: unknown): PersistedReviewState {
  const parsed = persistedReviewsSchema.safeParse(value);
  return parsed.success ? parsed.data : { submitted: {} };
}

export function createReviewStore(storage: StateStorage<void>): ReviewStore {
  return create<ReviewStoreState>()(
    persist<ReviewStoreState, [], [], PersistedReviewState>(
      (set, get) => ({
        submitted: {},
        snoozed: {},
        markSubmitted: (orderId, review) => {
          set({ submitted: { ...get().submitted, [orderId]: review } });
        },
        snooze: (orderId) => {
          set({ snoozed: { ...get().snoozed, [orderId]: true } });
        },
      }),
      {
        name: REVIEW_STORE_KEY,
        version: REVIEW_STORE_VERSION,
        storage: createJSONStorage<PersistedReviewState>(() => storage),
        partialize: ({ submitted }): PersistedReviewState => ({ submitted }),
        migrate: (persisted) => toPersistedReviews(persisted),
        merge: (persisted, current) => ({ ...current, ...toPersistedReviews(persisted) }),
      },
    ),
  );
}

export const useReviewStore: ReviewStore = createReviewStore(mmkvStateStorage(getAppStorage()));
