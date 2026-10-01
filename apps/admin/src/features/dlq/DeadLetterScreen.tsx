import type { DeadLetterStatus, DeadLetterView } from '@hamro-pasal/shared-types';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { useAdminApi } from '../../app-context';
import { formatDateTime } from '../../lib/format';
import {
  DEAD_LETTER_STATUS_LABELS,
  hasQueuedRetry,
  messageBody,
  retryButton,
  retryErrorMessage,
  sourceLabel,
} from './dead-letter-rules';

const FILTERS: readonly {
  readonly label: string;
  readonly status: DeadLetterStatus | undefined;
}[] = [
  { label: 'All', status: undefined },
  { label: 'Pending', status: 'PENDING' },
  { label: 'Retry queued', status: 'RETRY_REQUESTED' },
  { label: 'Replayed', status: 'REPLAYED' },
];

/** How often the list refreshes while a retry is waiting for the worker. */
const QUEUED_REFRESH_MS = 3_000;

/**
 * Phase 15 DLQ monitor: every message a worker consumer gave up on (dead_letter_events), newest
 * first, with its failure reason. Retry asks the worker to republish it to its source topic.
 */
export function DeadLetterScreen() {
  const api = useAdminApi();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<DeadLetterStatus | undefined>(undefined);
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});

  const query = useInfiniteQuery({
    queryKey: ['admin', 'dlq', status ?? 'ALL'],
    queryFn: ({ pageParam }) => api.listDeadLetters({ status, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.next_cursor ?? undefined,
    refetchInterval: (current) =>
      hasQueuedRetry(current.state.data?.pages.flatMap((page) => page.dead_letters) ?? [])
        ? QUEUED_REFRESH_MS
        : false,
  });

  const retry = useMutation({
    mutationFn: (id: string) => api.retryDeadLetter(id),
    onMutate: (id) => {
      setErrors(({ [id]: _cleared, ...rest }) => rest);
    },
    onError: (error, id) => {
      setErrors((current) => ({ ...current, [id]: retryErrorMessage(error) }));
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['admin', 'dlq'] }),
  });

  const letters = query.data?.pages.flatMap((page) => page.dead_letters) ?? [];

  return (
    <section>
      <div className="section-head">
        <div>
          <h2>Dead letters</h2>
          <p className="muted">
            Messages a worker consumer gave up on after its retries. Retry republishes the stored
            message to its source topic; if it fails again it comes back as a new row.
          </p>
        </div>
        <button
          type="button"
          className="button"
          disabled={query.isFetching}
          onClick={() => void query.refetch()}
        >
          {query.isFetching ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      <div className="filters" role="group" aria-label="Filter by status">
        {FILTERS.map((filter) => (
          <button
            key={filter.label}
            type="button"
            className="chip"
            aria-pressed={filter.status === status}
            onClick={() => {
              setStatus(filter.status);
            }}
          >
            {filter.label}
          </button>
        ))}
      </div>

      {query.isPending ? (
        <p className="muted">Loading…</p>
      ) : query.isError ? (
        <p className="error" role="alert">
          The dead letters could not be loaded.{' '}
          <button type="button" className="link" onClick={() => void query.refetch()}>
            Try again
          </button>
        </p>
      ) : letters.length === 0 ? (
        <p className="empty">No dead letters{status === undefined ? '' : ' with this status'}.</p>
      ) : (
        <ul className="cards">
          {letters.map((letter) => (
            <DeadLetterCard
              key={letter.id}
              letter={letter}
              retrying={retry.isPending && retry.variables === letter.id}
              error={errors[letter.id] ?? null}
              onRetry={() => {
                retry.mutate(letter.id);
              }}
            />
          ))}
        </ul>
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
    </section>
  );
}

function DeadLetterCard({
  letter,
  retrying,
  error,
  onRetry,
}: {
  readonly letter: DeadLetterView;
  readonly retrying: boolean;
  readonly error: string | null;
  readonly onRetry: () => void;
}) {
  const [open, setOpen] = useState(false);
  const button = retryButton(letter);

  return (
    <li className="card">
      <div className="card-head">
        <div className="card-title">
          <span className={`badge status-${letter.status.toLowerCase()}`}>
            {DEAD_LETTER_STATUS_LABELS[letter.status]}
          </span>
          <strong>{letter.event_type ?? 'Unparseable message'}</strong>
          <span className="muted small">{formatDateTime(letter.failed_at)}</span>
        </div>
        <button
          type="button"
          className="button primary"
          disabled={!button.enabled || retrying}
          onClick={onRetry}
        >
          {retrying ? 'Requesting…' : button.label}
        </button>
      </div>

      <p className="failure">
        <span className="failure-name">{letter.error_name}</span> {letter.error_message}
      </p>
      <dl className="facts">
        <div>
          <dt>Consumer</dt>
          <dd>{letter.consumer}</dd>
        </div>
        <div>
          <dt>Source</dt>
          <dd className="mono">{sourceLabel(letter)}</dd>
        </div>
        <div>
          <dt>Attempts</dt>
          <dd>{letter.attempts}</dd>
        </div>
        {letter.message_key !== null && (
          <div>
            <dt>Key</dt>
            <dd className="mono">{letter.message_key}</dd>
          </div>
        )}
        {letter.replay_of_id !== null && (
          <div>
            <dt>Retry of</dt>
            <dd className="mono">{letter.replay_of_id}</dd>
          </div>
        )}
        {letter.retry_requested_at !== null && (
          <div>
            <dt>Retry asked</dt>
            <dd>{formatDateTime(letter.retry_requested_at)}</dd>
          </div>
        )}
        {letter.replayed_at !== null && (
          <div>
            <dt>Replayed</dt>
            <dd>{formatDateTime(letter.replayed_at)}</dd>
          </div>
        )}
      </dl>
      {letter.last_replay_error !== null && letter.status === 'RETRY_REQUESTED' && (
        <p className="warning">
          The worker could not republish it ({String(letter.replay_attempts)} tries):{' '}
          {letter.last_replay_error}
        </p>
      )}
      {error !== null && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      <button
        type="button"
        className="link"
        aria-expanded={open}
        onClick={() => {
          setOpen(!open);
        }}
      >
        {open ? 'Hide message' : 'Show message'}
      </button>
      {open && (
        <div className="message">
          {letter.event_id !== null && <p className="small mono">event_id {letter.event_id}</p>}
          <pre>{messageBody(letter)}</pre>
          {Object.keys(letter.headers).length > 0 && (
            <pre className="headers">{JSON.stringify(letter.headers, null, 2)}</pre>
          )}
        </div>
      )}
    </li>
  );
}
