import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useState } from 'react';

import { ApiError } from '../../api/client';
import { useAdminApi } from '../../app-context';
import { formatDateTime } from '../../lib/format';
import {
  addVendors,
  AUDIENCE_LABELS,
  confirmationText,
  counter,
  MAX_ADMIN_NOTIFICATION_VENDORS,
  NOTIFICATION_BODY_MAX_LENGTH,
  NOTIFICATION_TITLE_MAX_LENGTH,
  pushOutcomeText,
  removeVendor,
  sendErrorMessage,
  sentText,
  validateDraft,
  vendorLabel,
  type Audience,
  type ChosenVendor,
} from './notification-rules';

const HISTORY_KEY = ['admin', 'notifications'] as const;

/** The search text, settled for 300 ms, so each keystroke does not query the API. */
function useSettled(value: string, ms = 300): string {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => {
      setSettled(value);
    }, ms);
    return () => {
      clearTimeout(timer);
    };
  }, [value, ms]);
  return settled;
}

/**
 * Notifications (step 7.5, SPEC core 11, Super Admin flow 10): a push to chosen shops (up to 500,
 * found by name or Vendor Code and always shown with their code) or to all customers. Every
 * message is also kept in each recipient's in-app notification centre. Sending asks for a second
 * press that names the recipients. Below: what was sent, with the push outcome.
 */
export function NotificationScreen() {
  const api = useAdminApi();
  const queryClient = useQueryClient();
  const ids = { title: useId(), body: useId(), link: useId(), search: useId() };
  const [audience, setAudience] = useState<Audience>('VENDORS');
  const [search, setSearch] = useState('');
  const [chosen, setChosen] = useState<readonly ChosenVendor[]>([]);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [deepLink, setDeepLink] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const q = useSettled(search.trim());
  const results = useQuery({
    queryKey: ['admin', 'vendor-search', q],
    queryFn: () => api.searchVendors(q),
    enabled: audience === 'VENDORS' && q.length >= 2,
  });
  const history = useQuery({ queryKey: HISTORY_KEY, queryFn: () => api.listNotifications() });

  const send = useMutation({
    mutationFn: (request: Parameters<typeof api.sendNotification>[0]) =>
      api.sendNotification(request),
    onSuccess: (sent) => {
      setNotice(sentText(audience, sent.recipient_count));
      setTitle('');
      setBody('');
      setDeepLink('');
      setChosen([]);
    },
    onError: (failure) => {
      setError(sendErrorMessage(failure));
    },
    onSettled: () => {
      setConfirming(false);
      return queryClient.invalidateQueries({ queryKey: HISTORY_KEY });
    },
  });

  const draft = { audience, chosen, title, body, deepLink };
  const add = (candidates: readonly ChosenVendor[]) => {
    const result = addVendors(chosen, candidates);
    if (result.ok) {
      setChosen(result.chosen);
      setError(null);
    } else {
      setError(result.error);
    }
  };
  const onSend = () => {
    if (send.isPending) return;
    setNotice(null);
    const result = validateDraft(draft);
    if (!result.ok) {
      setError(result.error);
      setConfirming(false);
      return;
    }
    setError(null);
    if (!confirming) {
      setConfirming(true);
      return;
    }
    send.mutate(result.request);
  };

  const found = results.data?.vendors ?? [];
  const chosenIds = new Set(chosen.map((vendor) => vendor.id));

  return (
    <section>
      <div className="section-head">
        <div>
          <h2>Notifications</h2>
          <p className="muted">
            Push a message to chosen shops (up to {MAX_ADMIN_NOTIFICATION_VENDORS}) or to all
            customers. It is also kept in each recipient&apos;s notification centre, even if the
            push does not reach the phone. Every send is audited.
          </p>
        </div>
      </div>

      <fieldset className="card" disabled={send.isPending}>
        <legend>Audience</legend>
        <label>
          <input
            type="radio"
            name="audience"
            checked={audience === 'VENDORS'}
            onChange={() => {
              setAudience('VENDORS');
              setConfirming(false);
            }}
          />{' '}
          Chosen shops
        </label>{' '}
        <label>
          <input
            type="radio"
            name="audience"
            checked={audience === 'ALL_CUSTOMERS'}
            onChange={() => {
              setAudience('ALL_CUSTOMERS');
              setConfirming(false);
            }}
          />{' '}
          All customers (at most once every 10 minutes)
        </label>
        {audience === 'VENDORS' ? (
          <div>
            <label htmlFor={ids.search}>Find shops by name or Vendor Code (HPV-00042)</label>
            <input
              id={ids.search}
              type="search"
              value={search}
              placeholder="Thamel Kirana, or HPV-00042"
              onChange={(event) => {
                setSearch(event.target.value);
              }}
            />
            {results.isError ? (
              <p className="error" role="alert">
                {results.error instanceof ApiError && results.error.code === 'NETWORK_ERROR'
                  ? 'The API cannot be reached.'
                  : 'The search failed.'}
              </p>
            ) : null}
            {found.length > 0 ? (
              <>
                <table>
                  <thead>
                    <tr>
                      <th>Shop</th>
                      <th>Vendor Code</th>
                      <th>Palika</th>
                      <th>Status</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {found.map((vendor) => (
                      <tr key={vendor.id}>
                        <td>{vendor.business_name}</td>
                        <td>
                          <code>{vendor.vendor_code}</code>
                        </td>
                        <td>{vendor.municipality_palika_string}</td>
                        <td>{vendor.status}</td>
                        <td>
                          <button
                            type="button"
                            className="button"
                            disabled={chosenIds.has(vendor.id)}
                            aria-label={`Add ${vendorLabel(vendor)}`}
                            onClick={() => {
                              add([vendor]);
                            }}
                          >
                            {chosenIds.has(vendor.id) ? 'Added' : 'Add'}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <button
                  type="button"
                  className="link"
                  onClick={() => {
                    add(found);
                  }}
                >
                  Add all {found.length} results
                </button>
              </>
            ) : q.length >= 2 && results.isSuccess ? (
              <p className="muted">No shop matches “{q}”.</p>
            ) : null}

            <p className="muted">
              {chosen.length} of {MAX_ADMIN_NOTIFICATION_VENDORS} shops chosen
              {chosen.length > 0 ? (
                <>
                  {' '}
                  <button
                    type="button"
                    className="link"
                    onClick={() => {
                      setChosen([]);
                    }}
                  >
                    Clear
                  </button>
                </>
              ) : null}
            </p>
            <ul className="chips">
              {chosen.map((vendor) => (
                <li key={vendor.id} className="chip">
                  {vendorLabel(vendor)}{' '}
                  <button
                    type="button"
                    className="link"
                    aria-label={`Remove ${vendorLabel(vendor)}`}
                    onClick={() => {
                      setChosen((current) => removeVendor(current, vendor.id));
                      setConfirming(false);
                    }}
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </fieldset>

      <fieldset className="card" disabled={send.isPending}>
        <legend>Message</legend>
        <label htmlFor={ids.title}>Title</label>
        <input
          id={ids.title}
          value={title}
          maxLength={NOTIFICATION_TITLE_MAX_LENGTH}
          onChange={(event) => {
            setTitle(event.target.value);
            setConfirming(false);
          }}
        />
        <p className="muted">{counter(title, NOTIFICATION_TITLE_MAX_LENGTH)}</p>
        <label htmlFor={ids.body}>Message</label>
        <textarea
          id={ids.body}
          value={body}
          rows={3}
          maxLength={NOTIFICATION_BODY_MAX_LENGTH}
          onChange={(event) => {
            setBody(event.target.value);
            setConfirming(false);
          }}
        />
        <p className="muted">{counter(body, NOTIFICATION_BODY_MAX_LENGTH)}</p>
        <label htmlFor={ids.link}>Opens in the app (optional), e.g. /orders</label>
        <input
          id={ids.link}
          value={deepLink}
          onChange={(event) => {
            setDeepLink(event.target.value);
            setConfirming(false);
          }}
        />

        <div className="card preview" aria-label="Preview">
          <strong>{title.trim() === '' ? 'Title' : title.trim()}</strong>
          <p>{body.trim() === '' ? 'Your message' : body.trim()}</p>
        </div>

        {error === null ? null : (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {notice === null ? null : <p className="success">{notice}</p>}
        {confirming ? <p className="warning">{confirmationText(draft)}</p> : null}
        <button type="button" className="button primary" onClick={onSend}>
          {send.isPending ? 'Sending…' : confirming ? 'Yes, send now' : 'Send'}
        </button>
        {confirming ? (
          <button
            type="button"
            className="button"
            onClick={() => {
              setConfirming(false);
            }}
          >
            Cancel
          </button>
        ) : null}
      </fieldset>

      <h3>Sent</h3>
      {history.isPending ? <p className="muted">Loading…</p> : null}
      {history.isError ? (
        <p className="error" role="alert">
          The history could not be loaded.{' '}
          <button type="button" className="link" onClick={() => void history.refetch()}>
            Try again
          </button>
        </p>
      ) : null}
      {history.data !== undefined ? (
        <table>
          <thead>
            <tr>
              <th>Sent</th>
              <th>To</th>
              <th>Title</th>
              <th>Recipients</th>
              <th>Push</th>
            </tr>
          </thead>
          <tbody>
            {history.data.notifications.map((row) => (
              <tr key={row.id}>
                <td>{formatDateTime(row.created_at)}</td>
                <td>{AUDIENCE_LABELS[row.audience]}</td>
                <td title={row.body}>{row.title}</td>
                <td>{row.recipient_count}</td>
                <td>{pushOutcomeText(row)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </section>
  );
}
