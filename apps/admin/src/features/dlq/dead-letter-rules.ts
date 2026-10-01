import type { DeadLetterStatus, DeadLetterView } from '@hamro-pasal/shared-types';

import { ApiError } from '../../api/client';

export const DEAD_LETTER_STATUS_LABELS: Readonly<Record<DeadLetterStatus, string>> = {
  PENDING: 'Pending',
  RETRY_REQUESTED: 'Retry queued',
  REPLAYED: 'Replayed',
};

export interface RetryButton {
  readonly label: string;
  readonly enabled: boolean;
}

/**
 * The Retry button of one dead letter. A queued retry is waiting for the worker's replayer; if the
 * replayer has been failing to publish it (replay_attempts > 0), the admin may push it again.
 */
export function retryButton(letter: DeadLetterView): RetryButton {
  switch (letter.status) {
    case 'PENDING':
      return { label: 'Retry', enabled: true };
    case 'RETRY_REQUESTED':
      return letter.replay_attempts > 0
        ? { label: 'Retry again', enabled: true }
        : { label: 'Queued', enabled: false };
    case 'REPLAYED':
      return { label: 'Replayed', enabled: false };
  }
}

/** While a retry is queued, the list refreshes itself to show it turn REPLAYED. */
export function hasQueuedRetry(letters: readonly DeadLetterView[]): boolean {
  return letters.some((letter) => letter.status === 'RETRY_REQUESTED');
}

/** "notifications.broadcast · partition 1 · offset 42" */
export function sourceLabel(letter: DeadLetterView): string {
  return `${letter.source_topic} · partition ${String(letter.source_partition)} · offset ${letter.source_offset}`;
}

/** The message body for display: pretty JSON when it parsed, else the raw text. */
export function messageBody(letter: DeadLetterView): string {
  if (letter.payload !== null) return JSON.stringify(letter.payload, null, 2);
  return letter.raw_value ?? '(empty message)';
}

export function retryErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    switch (error.code) {
      case 'DEAD_LETTER_ALREADY_REPLAYED':
        return 'This message was already replayed. If it failed again, it is listed as a new dead letter.';
      case 'DEAD_LETTER_NOT_FOUND':
        return 'This dead letter no longer exists.';
      case 'NETWORK_ERROR':
        return 'The API cannot be reached. Try again.';
      default:
        break;
    }
  }
  return 'The retry could not be requested. Try again.';
}
