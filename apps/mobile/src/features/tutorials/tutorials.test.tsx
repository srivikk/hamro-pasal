import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import { http, HttpResponse } from 'msw';

import { setAppVariantForTests } from '../../lib/app-variant';
import { useDismissedTutorialsStore } from '../../store/useDismissedTutorialsStore';
import { mockWebView, resetMockWebView } from '../../test/mock-webview';
import { apiUrl, server, setupApiTestEnvironment } from '../../test/msw';
import { renderWithProviders } from '../../test/render';
import { embedUrl, isEmbedNavigation, thumbnailUrl } from './tutorial-embed';
import { TutorialCard } from './TutorialCard';

setupApiTestEnvironment();

const video = (id: string, title: string, order = 0) => ({
  id: `5d1c2a10-0000-4000-8000-${String(order).padStart(12, '0')}`,
  app: 'CUSTOMER',
  youtube_video_id: id,
  title,
  display_order: order,
  is_active: true,
});

function serve(videos: unknown[], asked: string[] = []) {
  server.use(
    http.get(apiUrl('/api/tutorials'), ({ request }) => {
      asked.push(new URL(request.url).searchParams.get('app') ?? '');
      return HttpResponse.json({ tutorials: videos });
    }),
  );
  return asked;
}

beforeEach(() => {
  resetMockWebView();
  useDismissedTutorialsStore.setState({ dismissed: {} });
});

describe('the embedded player rules (step 7.8)', () => {
  it('embeds the privacy-enhanced player inline, and the thumbnail from ytimg', () => {
    expect(embedUrl('dQw4w9WgXcQ')).toBe(
      'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?playsinline=1&rel=0&modestbranding=1',
    );
    expect(thumbnailUrl('dQw4w9WgXcQ')).toBe('https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg');
    expect(() => embedUrl('../evil')).toThrow(RangeError);
  });

  it('lets the player load only this video’s embed page, never YouTube itself', () => {
    const id = 'dQw4w9WgXcQ';
    expect(isEmbedNavigation(embedUrl(id), id)).toBe(true);
    expect(isEmbedNavigation('about:blank', id)).toBe(true);
    expect(isEmbedNavigation(`https://www.youtube.com/watch?v=${id}`, id)).toBe(false);
    expect(isEmbedNavigation('https://www.youtube-nocookie.com/embed/otherVideo1', id)).toBe(false);
    expect(isEmbedNavigation('vnd.youtube://dQw4w9WgXcQ', id)).toBe(false);
    expect(isEmbedNavigation('intent://www.youtube.com/watch#Intent;end', id)).toBe(false);
    expect(isEmbedNavigation('not a url', id)).toBe(false);
  });
});

describe('the tutorial card', () => {
  it('shows this app’s first video and plays it inside the app', async () => {
    const asked = serve([video('dQw4w9WgXcQ', 'Place your first order')]);
    renderWithProviders(<TutorialCard />);

    expect(await screen.findByTestId('tutorial-card')).toHaveTextContent(/Place your first order/);
    expect(asked).toEqual(['CUSTOMER']);
    expect(screen.getByTestId('tutorial-card-thumbnail').props.source).toEqual({
      uri: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg',
    });

    fireEvent.press(screen.getByTestId('tutorial-card-play'));

    const props = mockWebView.props;
    expect(props?.source).toEqual({ uri: embedUrl('dQw4w9WgXcQ') });
    expect(props?.allowsInlineMediaPlayback).toBe(true);
    expect(props?.allowsFullscreenVideo).toBe(true);
    expect(props?.setSupportMultipleWindows).toBe(false);
    // A tap on the YouTube logo is refused: the viewer stays in the app.
    const guard = props?.onShouldStartLoadWithRequest;
    expect(guard?.({ url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' } as never)).toBe(false);
    expect(guard?.({ url: embedUrl('dQw4w9WgXcQ') } as never)).toBe(true);

    fireEvent.press(screen.getByTestId('tutorial-player-close'));
  });

  it('remembers "Don’t show again" per video and shows the next one', async () => {
    serve([video('dQw4w9WgXcQ', 'First video', 0), video('aBcDeFgHiJ_', 'Second video', 1)]);
    renderWithProviders(<TutorialCard />);

    expect(await screen.findByTestId('tutorial-card')).toHaveTextContent(/First video/);
    fireEvent.press(screen.getByTestId('tutorial-card-dismiss'));

    await waitFor(() => {
      expect(screen.getByTestId('tutorial-card')).toHaveTextContent(/Second video/);
    });
    expect(useDismissedTutorialsStore.getState().dismissed).toEqual({ dQw4w9WgXcQ: true });

    fireEvent.press(screen.getByTestId('tutorial-card-dismiss'));
    await waitFor(() => {
      expect(screen.queryByTestId('tutorial-card')).toBeNull();
    });
  });

  it('asks for the Seller app’s videos in the Seller build, and shows nothing without any', async () => {
    setAppVariantForTests('SELLER');
    try {
      const asked = serve([]);
      renderWithProviders(<TutorialCard />);
      await waitFor(() => {
        expect(asked).toEqual(['SELLER']);
      });
      expect(screen.queryByTestId('tutorial-card')).toBeNull();
    } finally {
      setAppVariantForTests('CUSTOMER');
    }
  });
});
