import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';

import { useAdminApi } from '../../app-context';
import {
  onboardingErrorMessage,
  toggledTutorial,
  validateTutorialDraft,
  type TutorialDraft,
} from './onboarding-rules';

const TUTORIALS_KEY = ['admin', 'tutorials'] as const;

const EMPTY: TutorialDraft = { app: 'CUSTOMER', video: '', title: '', displayOrder: '' };

/**
 * Tutorials (step 7.8, Super Admin flow 10): the YouTube videos each app shows in its floating
 * card and plays inside the app. Lower order first; a hidden video is kept but not shown.
 */
export function TutorialScreen() {
  const api = useAdminApi();
  const queryClient = useQueryClient();
  const ids = { app: useId(), video: useId(), title: useId(), order: useId() };
  const [draft, setDraft] = useState<TutorialDraft>(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const tutorials = useQuery({ queryKey: TUTORIALS_KEY, queryFn: () => api.listTutorials() });
  const refresh = () => queryClient.invalidateQueries({ queryKey: TUTORIALS_KEY });

  const create = useMutation({
    mutationFn: (input: Parameters<typeof api.createTutorial>[0]) => api.createTutorial(input),
    onSuccess: () => {
      setDraft(EMPTY);
    },
    onError: (failure) => {
      setError(onboardingErrorMessage(failure));
    },
    onSettled: refresh,
  });
  const update = useMutation({
    mutationFn: ({ id, input }: { id: string; input: Parameters<typeof api.updateTutorial>[1] }) =>
      api.updateTutorial(id, input),
    onSettled: refresh,
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.deleteTutorial(id),
    onSettled: refresh,
  });

  const onAdd = () => {
    if (create.isPending) return;
    const result = validateTutorialDraft(draft);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setError(null);
    create.mutate(result.request);
  };

  return (
    <section>
      <div className="section-head">
        <div>
          <h2>Tutorials</h2>
          <p className="muted">
            Videos shown in a small card in the customer app and the Seller app. They play inside
            the app, never in YouTube.
          </p>
        </div>
      </div>
      <fieldset className="card" disabled={create.isPending}>
        <legend>Add a video</legend>
        <label htmlFor={ids.app}>App</label>
        <select
          id={ids.app}
          value={draft.app}
          onChange={(e) => {
            setDraft((d) => ({ ...d, app: e.target.value as TutorialDraft['app'] }));
          }}
        >
          <option value="CUSTOMER">Customer app</option>
          <option value="SELLER">Seller app</option>
        </select>
        <label htmlFor={ids.video}>YouTube link or video id</label>
        <input
          id={ids.video}
          value={draft.video}
          onChange={(e) => {
            setDraft((d) => ({ ...d, video: e.target.value }));
          }}
        />
        <label htmlFor={ids.title}>Title</label>
        <input
          id={ids.title}
          value={draft.title}
          maxLength={80}
          onChange={(e) => {
            setDraft((d) => ({ ...d, title: e.target.value }));
          }}
        />
        <label htmlFor={ids.order}>Order (lower first)</label>
        <input
          id={ids.order}
          value={draft.displayOrder}
          onChange={(e) => {
            setDraft((d) => ({ ...d, displayOrder: e.target.value }));
          }}
        />
        {error === null ? null : (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button type="button" className="button primary" onClick={onAdd}>
          Add video
        </button>
      </fieldset>

      {tutorials.isPending ? <p className="muted">Loading…</p> : null}
      {tutorials.isError ? (
        <p className="error" role="alert">
          The videos could not be loaded.
        </p>
      ) : null}
      {tutorials.data !== undefined ? (
        <table>
          <thead>
            <tr>
              <th>App</th>
              <th>Order</th>
              <th>Title</th>
              <th>Video</th>
              <th>Shown</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {tutorials.data.map((video) => (
              <tr key={video.id}>
                <td>{video.app === 'SELLER' ? 'Seller' : 'Customer'}</td>
                <td>{video.display_order}</td>
                <td>{video.title}</td>
                <td>
                  <code>{video.youtube_video_id}</code>
                </td>
                <td>{video.is_active ? 'Yes' : 'Hidden'}</td>
                <td>
                  <button
                    type="button"
                    className="link"
                    onClick={() => {
                      update.mutate({ id: video.id, input: toggledTutorial(video) });
                    }}
                  >
                    {video.is_active ? 'Hide' : 'Show'}
                  </button>{' '}
                  <button
                    type="button"
                    className="link"
                    onClick={() => {
                      remove.mutate(video.id);
                    }}
                  >
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </section>
  );
}
