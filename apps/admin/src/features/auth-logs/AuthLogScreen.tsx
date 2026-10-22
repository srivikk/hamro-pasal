import type { AdminOtpRevealResponseBody, AuthLogEntry } from '@hamro-pasal/shared-types';
import { useInfiniteQuery, useMutation } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState } from 'react';

import { useAdminApi } from '../../app-context';
import { formatDateTime } from '../../lib/format';
import {
  AUTH_EVENT_LABELS,
  authLogErrorMessage,
  checkRevealReason,
  countdown,
  eventTone,
  normalisePhone,
} from './auth-log-rules';

/** The log refreshes on its own: support watches a caller's code arrive. */
const LOG_REFRESH_MS = 5_000;

/**
 * 2026-10-21 (Task 5, decided by the user: "guarded reveal"): every login-code send and check,
 * newest first, filterable by number, as a failsafe when an SMS is late. The newest live code of
 * a number can be revealed after writing why; the reveal is audited (the number masked, the
 * reason, never the code) and works only where the server runs with OTP_ADMIN_REVEAL on.
 */
export function AuthLogScreen() {
  const api = useAdminApi();
  const filterId = useId();
  const [typed, setTyped] = useState('');
  const phone = normalisePhone(typed) ?? undefined;
  const [revealing, setRevealing] = useState<AuthLogEntry | null>(null);

  const query = useInfiniteQuery({
    queryKey: ['admin', 'auth-logs', phone ?? 'ALL'],
    queryFn: ({ pageParam }) => api.listAuthLogs({ phone, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.next_cursor ?? undefined,
    refetchInterval: LOG_REFRESH_MS,
  });
  const entries = query.data?.pages.flatMap((page) => page.entries) ?? [];
  const revealEnabled = query.data?.pages[0]?.reveal_enabled ?? false;

  return (
    <section>
      <div className="section-head">
        <div>
          <h2>Authentication logs</h2>
          <p className="muted">
            Every login code sent and checked, newest first. When an SMS is late, a live code can be
            read out to its owner after you write why; each reveal is kept in the audit log.
            {!revealEnabled && ' Revealing is switched off on this server.'}
          </p>
        </div>
      </div>

      <div className="setting">
        <label htmlFor={`${filterId}-phone`}>Phone number</label>
        <input
          id={`${filterId}-phone`}
          inputMode="tel"
          placeholder="98XXXXXXXX"
          value={typed}
          onChange={(event) => {
            setTyped(event.target.value);
          }}
        />
        {typed.trim() !== '' && phone === undefined && (
          <p className="muted small">Type a 10-digit number starting with 9 to filter.</p>
        )}
      </div>

      {query.isPending ? (
        <p className="muted">Loading…</p>
      ) : query.isError ? (
        <p className="error" role="alert">
          {authLogErrorMessage(query.error)}
        </p>
      ) : entries.length === 0 ? (
        <p className="empty">Nothing logged{phone === undefined ? '' : ' for this number'}.</p>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>When</th>
                <th>Number</th>
                <th>Event</th>
                <th>Detail</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.id} data-testid={`auth-event-${entry.id}`}>
                  <td>{formatDateTime(entry.created_at)}</td>
                  <td className="mono">{entry.phone}</td>
                  <td>
                    <span className={`badge tone-${eventTone(entry.kind)}`}>
                      {AUTH_EVENT_LABELS[entry.kind]}
                    </span>
                  </td>
                  <td className="muted small">{entry.detail ?? ''}</td>
                  <td>
                    {revealEnabled && entry.revealable && (
                      <button
                        type="button"
                        className="button"
                        onClick={() => {
                          setRevealing(entry);
                        }}
                      >
                        Reveal code
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

      {revealing !== null && (
        <RevealDialog
          entry={revealing}
          onClose={() => {
            setRevealing(null);
          }}
        />
      )}
    </section>
  );
}

function RevealDialog({
  entry,
  onClose,
}: {
  readonly entry: AuthLogEntry;
  readonly onClose: () => void;
}) {
  const api = useAdminApi();
  const formId = useId();
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const reveal = useMutation({
    mutationFn: (checked: string) => api.revealOtp(entry.phone, checked),
  });
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog !== null && !dialog.open) dialog.showModal();
  }, []);

  return (
    // A native modal dialog: focus is trapped inside it and Escape closes it.
    <dialog ref={dialogRef} className="modal" aria-labelledby={`${formId}-title`} onClose={onClose}>
      <h2 id={`${formId}-title`}>Reveal the login code of {entry.phone}</h2>
      {reveal.data === undefined ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const checked = checkRevealReason(reason);
            setProblem(checked.ok ? null : checked.message);
            if (checked.ok) reveal.mutate(checked.reason);
          }}
        >
          <p className="muted small">
            Read it only to the number&apos;s owner, on a call you can verify. Your reason is kept
            in the audit log with your name.
          </p>
          <label htmlFor={`${formId}-reason`}>Why do you need it?</label>
          <textarea
            id={`${formId}-reason`}
            value={reason}
            onChange={(event) => {
              setReason(event.target.value);
            }}
          />
          {problem !== null && <p className="error small">{problem}</p>}
          {reveal.isError && (
            <p className="error" role="alert">
              {authLogErrorMessage(reveal.error)}
            </p>
          )}
          <div className="panel-actions">
            <button type="button" className="button ghost" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="button primary" disabled={reveal.isPending}>
              {reveal.isPending ? 'Revealing…' : 'Reveal'}
            </button>
          </div>
        </form>
      ) : (
        <RevealedCode revealed={reveal.data} onClose={onClose} />
      )}
    </dialog>
  );
}

function RevealedCode({
  revealed,
  onClose,
}: {
  readonly revealed: AdminOtpRevealResponseBody;
  readonly onClose: () => void;
}) {
  const [left, setLeft] = useState(revealed.expires_in_seconds);
  useEffect(() => {
    const timer = window.setInterval(() => {
      setLeft((current) => Math.max(0, current - 1));
    }, 1000);
    return () => {
      window.clearInterval(timer);
    };
  }, []);

  return (
    <div>
      <p className="otp-code mono" data-testid="revealed-code">
        {left > 0 ? revealed.code : '— expired —'}
      </p>
      <p className="muted small">
        {left > 0 ? `Expires in ${countdown(left)}. ` : ''}
        {String(revealed.attempts_used)} wrong attempt{revealed.attempts_used === 1 ? '' : 's'} so
        far. The code stays usable once.
      </p>
      <div className="panel-actions">
        <button type="button" className="button primary" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}
