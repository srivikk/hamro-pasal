import type { AdminProductReviewView } from '@hamro-pasal/shared-types';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState } from 'react';

import { useAdminApi } from '../../app-context';
import { formatDateTime } from '../../lib/format';
import {
  checkHideReason,
  REVIEW_FILTERS,
  reviewErrorMessage,
  stars,
  statusOf,
  type ReviewFilter,
} from './review-rules';

/**
 * 2026-10-22 (Task 6): every customer product review, newest first. A review that breaks platform
 * policy is hidden with a written reason (it then leaves the shop page and the product's average,
 * and is kept in the audit log); a hidden one can be shown again.
 */
export function ProductReviewScreen() {
  const api = useAdminApi();
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<ReviewFilter>('ALL');
  const [hiding, setHiding] = useState<AdminProductReviewView | null>(null);

  const query = useInfiniteQuery({
    queryKey: ['admin', 'product-reviews', filter],
    queryFn: ({ pageParam }) =>
      api.listProductReviews({ status: statusOf(filter), cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.next_cursor ?? undefined,
  });
  const reviews = query.data?.pages.flatMap((page) => page.reviews) ?? [];

  const show = useMutation({
    mutationFn: (id: string) => api.moderateProductReview(id, { hidden: false }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['admin', 'product-reviews'] }),
  });

  return (
    <section>
      <div className="section-head">
        <div>
          <h2>Product reviews</h2>
          <p className="muted">
            What customers wrote about the products they received. Hide a review that breaks
            platform policy: it leaves the shop page and the product&apos;s rating, and your reason
            is kept in the audit log.
          </p>
        </div>
      </div>

      <div className="filters" role="group" aria-label="Filter by state">
        {REVIEW_FILTERS.map((option) => (
          <button
            key={option.id}
            type="button"
            className="chip"
            aria-pressed={option.id === filter}
            onClick={() => {
              setFilter(option.id);
            }}
          >
            {option.label}
          </button>
        ))}
      </div>

      {show.isError && (
        <p className="error" role="alert">
          {reviewErrorMessage(show.error)}
        </p>
      )}

      {query.isPending ? (
        <p className="muted">Loading…</p>
      ) : query.isError ? (
        <p className="error" role="alert">
          {reviewErrorMessage(query.error)}
        </p>
      ) : reviews.length === 0 ? (
        <p className="empty">No reviews here.</p>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>When</th>
                <th>Product</th>
                <th>Review</th>
                <th>State</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {reviews.map((review) => (
                <tr key={review.id} data-testid={`product-review-${review.id}`}>
                  <td>{formatDateTime(review.created_at)}</td>
                  <td>
                    {review.product_name}
                    <div className="muted small">{review.vendor.business_name}</div>
                  </td>
                  <td>
                    <span aria-label={`${String(review.rating)} out of 5`}>
                      {stars(review.rating)}
                    </span>{' '}
                    <span className="muted small">{review.reviewer_first_name ?? 'Customer'}</span>
                    {review.comment !== null && <div>{review.comment}</div>}
                  </td>
                  <td>
                    {review.hidden ? (
                      <>
                        <span className="badge tone-bad">Hidden</span>
                        <div className="muted small">{review.hidden_reason}</div>
                      </>
                    ) : (
                      <span className="badge tone-ok">Published</span>
                    )}
                  </td>
                  <td>
                    {review.hidden ? (
                      <button
                        type="button"
                        className="button"
                        disabled={show.isPending}
                        onClick={() => {
                          show.mutate(review.id);
                        }}
                      >
                        Show again
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="button"
                        onClick={() => {
                          setHiding(review);
                        }}
                      >
                        Hide
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {query.hasNextPage && (
        <button
          type="button"
          className="button load-more"
          disabled={query.isFetchingNextPage}
          onClick={() => void query.fetchNextPage()}
        >
          {query.isFetchingNextPage ? 'Loading…' : 'Load older'}
        </button>
      )}

      {hiding !== null && (
        <HideDialog
          review={hiding}
          onClose={() => {
            setHiding(null);
          }}
        />
      )}
    </section>
  );
}

function HideDialog({
  review,
  onClose,
}: {
  readonly review: AdminProductReviewView;
  readonly onClose: () => void;
}) {
  const api = useAdminApi();
  const queryClient = useQueryClient();
  const formId = useId();
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const hide = useMutation({
    mutationFn: (checked: string) =>
      api.moderateProductReview(review.id, { hidden: true, reason: checked }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['admin', 'product-reviews'] });
      onClose();
    },
  });
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog !== null && !dialog.open) dialog.showModal();
  }, []);

  return (
    // A native modal dialog: focus is trapped inside it and Escape closes it.
    <dialog ref={dialogRef} className="modal" aria-labelledby={`${formId}-title`} onClose={onClose}>
      <h2 id={`${formId}-title`}>Hide this review of {review.product_name}</h2>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const checked = checkHideReason(reason);
          setProblem(checked.ok ? null : checked.message);
          if (checked.ok) hide.mutate(checked.reason);
        }}
      >
        <p className="muted small">
          {stars(review.rating)} {review.comment ?? '(no comment)'}
        </p>
        <label htmlFor={`${formId}-reason`}>Which policy does it break?</label>
        <textarea
          id={`${formId}-reason`}
          value={reason}
          onChange={(event) => {
            setReason(event.target.value);
          }}
        />
        {problem !== null && <p className="error small">{problem}</p>}
        {hide.isError && (
          <p className="error" role="alert">
            {reviewErrorMessage(hide.error)}
          </p>
        )}
        <div className="panel-actions">
          <button type="button" className="button ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="button primary" disabled={hide.isPending}>
            {hide.isPending ? 'Hiding…' : 'Hide review'}
          </button>
        </div>
      </form>
    </dialog>
  );
}
