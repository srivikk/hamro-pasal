import type { AdminDisputeView, ChatMessage } from '@hamro-pasal/shared-types';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';

import { useAdminApi } from '../../app-context';
import { formatDateTime, formatNpr } from '../../lib/format';
import {
  disputeErrorMessage,
  EMPTY_RESOLUTION,
  isResolved,
  moneyLine,
  OUTCOME_LABELS,
  validateResolution,
  type ResolutionForm,
} from './dispute-rules';

/** How often an open conversation is re-read (the dashboard has no socket). */
const TRANSCRIPT_REFRESH_MS = 5_000;

const SENDER_LABELS: Readonly<Record<string, string>> = {
  CUSTOMER: 'Customer',
  VENDOR: 'Shop',
  SUPER_ADMIN: 'Hamro Pasal',
};

/**
 * 2026-10-21 (Task 5, SPEC core 6 and Super Admin flow 9): the grievance desk. Escalated order
 * conversations, oldest first; each opens its whole chat (customer, shop and Hamro Pasal), where
 * the admin writes too, and its resolution. Until it is resolved the order's money stays frozen
 * in escrow: never paid out, never released on day 8.
 */
export function DisputeScreen() {
  const api = useAdminApi();
  const [status, setStatus] = useState<'ESCALATED' | 'RESOLVED'>('ESCALATED');
  const [openId, setOpenId] = useState<string | null>(null);

  const query = useInfiniteQuery({
    queryKey: ['admin', 'disputes', status],
    queryFn: ({ pageParam }) => api.listDisputes({ status, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.next_cursor ?? undefined,
  });
  const disputes = query.data?.pages.flatMap((page) => page.disputes) ?? [];
  const open = disputes.find((dispute) => dispute.dispute_id === openId) ?? null;

  return (
    <section>
      <div className="section-head">
        <div>
          <h2>Disputes</h2>
          <p className="muted">
            Conversations a customer or a shop escalated. Their money is frozen in escrow until you
            resolve them: release it to the shop, or refund the customer in full or in part.
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
        {(['ESCALATED', 'RESOLVED'] as const).map((value) => (
          <button
            key={value}
            type="button"
            className="chip"
            aria-pressed={value === status}
            onClick={() => {
              setStatus(value);
              setOpenId(null);
            }}
          >
            {value === 'ESCALATED' ? 'Waiting for you' : 'Resolved'}
          </button>
        ))}
      </div>

      {query.isPending ? (
        <p className="muted">Loading…</p>
      ) : query.isError ? (
        <p className="error" role="alert">
          The disputes could not be loaded.{' '}
          <button type="button" className="link" onClick={() => void query.refetch()}>
            Try again
          </button>
        </p>
      ) : disputes.length === 0 ? (
        <p className="empty">
          {status === 'ESCALATED' ? 'No dispute is waiting.' : 'No resolved dispute yet.'}
        </p>
      ) : (
        <ul className="cards">
          {disputes.map((dispute) => (
            <li
              key={dispute.dispute_id}
              className="card"
              data-testid={`dispute-${dispute.order_id}`}
            >
              <div className="card-head">
                <div className="card-title">
                  <span className={`badge status-${dispute.status.toLowerCase()}`}>
                    {dispute.status === 'ESCALATED' ? 'Escalated' : 'Resolved'}
                  </span>
                  <strong>{dispute.business_name}</strong>
                  <span className="muted small">
                    {dispute.escalated_at === null ? '' : formatDateTime(dispute.escalated_at)}
                  </span>
                </div>
                <button
                  type="button"
                  className="button"
                  aria-expanded={dispute.dispute_id === openId}
                  onClick={() => {
                    setOpenId(dispute.dispute_id === openId ? null : dispute.dispute_id);
                  }}
                >
                  {dispute.dispute_id === openId ? 'Close' : 'Open'}
                </button>
              </div>
              <p className="muted small">{moneyLine(dispute)}</p>
              <dl className="facts">
                <div>
                  <dt>Order total</dt>
                  <dd>{formatNpr(dispute.order_total_npr)}</dd>
                </div>
                <div>
                  <dt>Payment</dt>
                  <dd>{dispute.payment_method}</dd>
                </div>
                <div>
                  <dt>Escalated by</dt>
                  <dd>{dispute.escalated_by === 'VENDOR' ? 'The shop' : 'The customer'}</dd>
                </div>
                <div>
                  <dt>Reason</dt>
                  <dd>{dispute.escalation_reason ?? '—'}</dd>
                </div>
              </dl>
              {open !== null && open.dispute_id === dispute.dispute_id && (
                <DisputeDetail dispute={open} />
              )}
            </li>
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
          {query.isFetchingNextPage ? 'Loading…' : 'Load more'}
        </button>
      )}
    </section>
  );
}

function DisputeDetail({ dispute }: { readonly dispute: AdminDisputeView }) {
  const api = useAdminApi();
  const queryClient = useQueryClient();
  const formId = useId();
  const [draft, setDraft] = useState('');
  const [form, setForm] = useState<ResolutionForm>(EMPTY_RESOLUTION);
  const [errors, setErrors] = useState<Readonly<Partial<Record<'refund' | 'note', string>>>>({});
  const transcriptKey = ['admin', 'disputes', 'transcript', dispute.order_id];

  const transcript = useQuery({
    queryKey: transcriptKey,
    queryFn: () => api.disputeTranscript(dispute.order_id),
    refetchInterval: dispute.status === 'ESCALATED' ? TRANSCRIPT_REFRESH_MS : false,
  });

  const send = useMutation({
    mutationFn: (body: string) =>
      api.sendDisputeMessage(dispute.order_id, crypto.randomUUID(), body),
    onSuccess: () => {
      setDraft('');
      void queryClient.invalidateQueries({ queryKey: transcriptKey });
    },
  });

  const resolve = useMutation({
    mutationFn: () => {
      const result = validateResolution(form, dispute);
      if (!result.ok) throw new Error('invalid');
      return api.resolveDispute(dispute.dispute_id, result.request);
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin', 'disputes'] }),
  });

  const messages: readonly ChatMessage[] = transcript.data?.messages ?? [];

  return (
    <div className="dispute-detail">
      <h3>Conversation</h3>
      {transcript.isPending ? (
        <p className="muted">Loading…</p>
      ) : transcript.isError ? (
        <p className="error" role="alert">
          {disputeErrorMessage(transcript.error)}
        </p>
      ) : messages.length === 0 ? (
        <p className="empty">No message yet.</p>
      ) : (
        <ol className="chat" aria-label="Conversation">
          {messages.map((message) => (
            <li
              key={message.id}
              className={`chat-message from-${message.sender.role.toLowerCase()}`}
            >
              <div className="muted small">
                {SENDER_LABELS[message.sender.role] ?? message.sender.role}
                {message.sender.first_name === null ? '' : ` · ${message.sender.first_name}`} ·{' '}
                {formatDateTime(message.sent_at)}
              </div>
              {message.body !== '' && <p>{message.body}</p>}
              {message.attachments.map((attachment) => (
                <a key={attachment.url} href={attachment.url} target="_blank" rel="noreferrer">
                  <img className="thumb" src={attachment.url} alt="Evidence" />
                </a>
              ))}
            </li>
          ))}
        </ol>
      )}

      {dispute.status === 'ESCALATED' && (
        <>
          <form
            className="chat-compose"
            onSubmit={(event) => {
              event.preventDefault();
              if (draft.trim() !== '') send.mutate(draft.trim());
            }}
          >
            <label htmlFor={`${formId}-message`}>Write to both parties</label>
            <textarea
              id={`${formId}-message`}
              value={draft}
              maxLength={2000}
              onChange={(event) => {
                setDraft(event.target.value);
              }}
            />
            {send.isError && (
              <p className="error" role="alert">
                {disputeErrorMessage(send.error)}
              </p>
            )}
            <button
              type="submit"
              className="button primary"
              disabled={send.isPending || draft.trim() === ''}
            >
              {send.isPending ? 'Sending…' : 'Send'}
            </button>
          </form>

          <form
            className="resolution"
            onSubmit={(event) => {
              event.preventDefault();
              const result = validateResolution(form, dispute);
              setErrors(result.ok ? {} : result.errors);
              if (result.ok) resolve.mutate();
            }}
          >
            <h3>Resolve</h3>
            <fieldset>
              <legend>Outcome</legend>
              {(Object.keys(OUTCOME_LABELS) as (keyof typeof OUTCOME_LABELS)[]).map((outcome) => (
                <label key={outcome} className="check">
                  <input
                    type="radio"
                    name={`${formId}-outcome`}
                    checked={form.outcome === outcome}
                    onChange={() => {
                      setForm((current) => ({ ...current, outcome }));
                    }}
                  />
                  {OUTCOME_LABELS[outcome]}
                </label>
              ))}
            </fieldset>
            {form.outcome === 'PARTIAL_REFUND' && (
              <div className="setting">
                <label htmlFor={`${formId}-refund`}>Refund to the customer (NPR)</label>
                <input
                  id={`${formId}-refund`}
                  inputMode="decimal"
                  value={form.refund}
                  aria-invalid={errors.refund !== undefined}
                  onChange={(event) => {
                    setForm((current) => ({ ...current, refund: event.target.value }));
                  }}
                />
                {errors.refund !== undefined && <p className="error small">{errors.refund}</p>}
              </div>
            )}
            <div className="setting">
              <label htmlFor={`${formId}-note`}>Reason (sent to both parties)</label>
              <textarea
                id={`${formId}-note`}
                value={form.note}
                aria-invalid={errors.note !== undefined}
                onChange={(event) => {
                  setForm((current) => ({ ...current, note: event.target.value }));
                }}
              />
              {errors.note !== undefined && <p className="error small">{errors.note}</p>}
            </div>
            {resolve.isError && (
              <p className="error" role="alert">
                {disputeErrorMessage(resolve.error)}
              </p>
            )}
            <button type="submit" className="button primary" disabled={resolve.isPending}>
              {resolve.isPending ? 'Resolving…' : 'Resolve dispute'}
            </button>
          </form>
        </>
      )}
      {isResolved(dispute.status) && dispute.resolution_note !== null && (
        <p className="muted">Resolution: {dispute.resolution_note}</p>
      )}
    </div>
  );
}
