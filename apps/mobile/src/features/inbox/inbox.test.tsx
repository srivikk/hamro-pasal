import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import { router } from 'expo-router';
import { http, HttpResponse } from 'msw';

import NotificationsScreen from '../../../app/notifications';
import { useAuthStore } from '../../store/useAuthStore';
import { apiUrl, server, setupApiTestEnvironment } from '../../test/msw';
import { renderWithProviders } from '../../test/render';
import { adminMessageRouteOfTap } from '../notifications/notification-taps';
import {
  badgeText,
  deepLinkOf,
  NOTIFICATIONS_PATH,
  READ_ALL_PATH,
  readPath,
  UNREAD_COUNT_PATH,
} from './inbox-api';
import { notificationRowStyle } from './inbox-style';
import { NotificationBell } from './NotificationBell';
import { appBadgeCount, useAppBadge, useInboxRefreshOnPush } from './useInboxSync';
import { mockNotifications } from '../../test/fake-notifications';

jest.mock('expo-router', () => ({
  router: { push: jest.fn(), back: jest.fn() },
  Stack: {
    Screen: ({ options }: { options?: { headerRight?: () => unknown } }) =>
      (options?.headerRight?.() ?? null) as never,
  },
}));

setupApiTestEnvironment();

const ID = (n: number) => `5d1c2a10-0000-4000-8000-${String(n).padStart(12, '0')}`;

function message(n: number, overrides: Record<string, unknown> = {}) {
  return {
    id: ID(n),
    audience: 'VENDOR',
    source: 'ADMIN',
    title: `Title ${String(n)}`,
    body: `Body ${String(n)}`,
    data: {},
    created_at: '2026-10-16T08:00:00.000Z',
    read_at: null,
    ...overrides,
  };
}

beforeEach(() => {
  jest.mocked(router.push).mockClear();
});

describe('notification centre helpers (step 7.5)', () => {
  it('follows only in-app links', () => {
    expect(deepLinkOf({ data: { deep_link: '/orders' } })).toBe('/orders');
    expect(deepLinkOf({ data: { deep_link: 'https://phish.example' } })).toBeNull();
    expect(deepLinkOf({ data: {} })).toBeNull();
  });

  it('caps the badge at 99+', () => {
    expect(badgeText(0)).toBeNull();
    expect(badgeText(7)).toBe('7');
    expect(badgeText(140)).toBe('99+');
  });
});

describe('the bell', () => {
  it('shows the unread count of a signed-in account and opens the centre', async () => {
    server.use(http.get(apiUrl(UNREAD_COUNT_PATH), () => HttpResponse.json({ unread: 3 })));
    renderWithProviders(<NotificationBell color="#000" />);

    expect(await screen.findByTestId('notification-badge')).toHaveTextContent('3');
    fireEvent.press(screen.getByTestId('notification-bell'));
    expect(router.push).toHaveBeenCalledWith('/notifications');
  });

  it('shows no badge with nothing unread, and nothing for a guest', async () => {
    const view = renderWithProviders(<NotificationBell color="#000" />);
    await waitFor(() => {
      expect(screen.getByTestId('notification-bell')).toBeOnTheScreen();
    });
    expect(screen.queryByTestId('notification-badge')).toBeNull();
    view.unmount();

    useAuthStore.setState({ accessToken: null, refreshToken: null });
    renderWithProviders(<NotificationBell color="#000" />);
    expect(screen.queryByTestId('notification-bell')).toBeNull();
  });
});

describe('the notification centre screen', () => {
  it('lists messages newest first, marks the unread ones, and loads the next page', async () => {
    const asked: (string | null)[] = [];
    server.use(
      http.get(apiUrl(NOTIFICATIONS_PATH), ({ request }) => {
        const cursor = new URL(request.url).searchParams.get('cursor');
        asked.push(cursor);
        return HttpResponse.json(
          cursor === null
            ? {
                notifications: [message(2), message(1, { read_at: '2026-10-16T09:00:00.000Z' })],
                next_cursor: ID(1),
              }
            : { notifications: [message(0)], next_cursor: null },
        );
      }),
    );
    renderWithProviders(<NotificationsScreen />);

    expect(await screen.findByTestId(`notification-${ID(2)}`)).toHaveTextContent(/^Title 2Body 2/);
    expect(screen.getByTestId(`notification-unread-${ID(2)}`)).toBeOnTheScreen();
    expect(screen.queryByTestId(`notification-unread-${ID(1)}`)).toBeNull();

    fireEvent(screen.getByTestId('notifications-list'), 'endReached');
    await waitFor(() => {
      expect(asked).toEqual([null, ID(1)]);
    });
  });

  it('marks a message read when tapped and opens its link', async () => {
    const reads: string[] = [];
    server.use(
      http.get(apiUrl(NOTIFICATIONS_PATH), () =>
        HttpResponse.json({
          notifications: [message(5, { data: { deep_link: '/orders' } })],
          next_cursor: null,
        }),
      ),
      http.post(apiUrl(readPath(ID(5))), () => {
        reads.push(ID(5));
        return HttpResponse.json({
          notification: message(5, {
            data: { deep_link: '/orders' },
            read_at: '2026-10-16T10:00:00.000Z',
          }),
        });
      }),
    );
    renderWithProviders(<NotificationsScreen />);

    fireEvent.press(await screen.findByTestId(`notification-${ID(5)}`));

    expect(router.push).toHaveBeenCalledWith('/orders');
    await waitFor(() => {
      expect(screen.queryByTestId(`notification-unread-${ID(5)}`)).toBeNull();
    });
    expect(reads).toEqual([ID(5)]);
  });

  it('marks everything read at once', async () => {
    let readAll = 0;
    server.use(
      http.get(apiUrl(NOTIFICATIONS_PATH), () =>
        HttpResponse.json({ notifications: [message(1), message(2)], next_cursor: null }),
      ),
      http.post(apiUrl(READ_ALL_PATH), () => {
        readAll += 1;
        return HttpResponse.json({ marked: 2 });
      }),
    );
    renderWithProviders(<NotificationsScreen />);
    await screen.findByTestId(`notification-unread-${ID(1)}`);

    fireEvent.press(screen.getByTestId('notifications-read-all'));

    await waitFor(() => {
      expect(screen.queryByTestId(`notification-unread-${ID(1)}`)).toBeNull();
    });
    expect(screen.queryByTestId(`notification-unread-${ID(2)}`)).toBeNull();
    expect(readAll).toBe(1);
  });

  it('says so when there is nothing, and offers a retry when loading fails', async () => {
    server.use(
      http.get(apiUrl(NOTIFICATIONS_PATH), () =>
        HttpResponse.json({ notifications: [], next_cursor: null }),
      ),
    );
    const view = renderWithProviders(<NotificationsScreen />);
    expect(await screen.findByTestId('notifications-empty')).toHaveTextContent(
      'No notifications yet.',
    );
    view.unmount();

    server.use(
      http.get(apiUrl(NOTIFICATIONS_PATH), () =>
        HttpResponse.json({ error: { code: 'NOT_FOUND', message: 'x' } }, { status: 404 }),
      ),
    );
    renderWithProviders(<NotificationsScreen />);
    expect(await screen.findByTestId('notifications-failed')).toBeOnTheScreen();
  });
});

describe('tapping an admin push (step 7.5)', () => {
  const tap = (data: unknown) => ({ notification: { request: { content: { data } } } });

  it('opens its in-app link, or the notification centre, and ignores other pushes', () => {
    expect(adminMessageRouteOfTap(tap({ type: 'admin.message', deep_link: '/orders' }))).toBe(
      '/orders',
    );
    expect(adminMessageRouteOfTap(tap({ type: 'admin.message' }))).toBe('/notifications');
    expect(
      adminMessageRouteOfTap(tap({ type: 'admin.message', deep_link: 'https://phish.example' })),
    ).toBe('/notifications');
    expect(adminMessageRouteOfTap(tap({ type: 'order.state_changed' }))).toBeNull();
    expect(adminMessageRouteOfTap(tap(undefined))).toBeNull();
  });
});

describe('read and unread states (2026-10-21)', () => {
  it('shows unread on a dark background in bold, read on a light one in regular weight', async () => {
    server.use(
      http.get(apiUrl(NOTIFICATIONS_PATH), () =>
        HttpResponse.json({
          notifications: [message(2), message(1, { read_at: '2026-10-16T09:00:00.000Z' })],
          next_cursor: null,
        }),
      ),
      http.get(apiUrl(UNREAD_COUNT_PATH), () => HttpResponse.json({ unread: 1 })),
    );
    renderWithProviders(<NotificationsScreen />);

    const unread = await screen.findByTestId(`notification-${ID(2)}`);
    const read = screen.getByTestId(`notification-${ID(1)}`);
    expect(String(unread.props.className)).toContain('bg-himalaya-dark');
    expect(String(screen.getByTestId(`notification-title-${ID(2)}`).props.className)).toContain(
      'font-bold text-white',
    );
    expect(String(read.props.className)).toContain('bg-surface ');
    expect(String(read.props.className)).not.toContain('bg-himalaya-dark');
    expect(String(screen.getByTestId(`notification-title-${ID(1)}`).props.className)).toContain(
      'font-normal',
    );
    expect(await screen.findByTestId('notifications-unread-badge')).toHaveTextContent('1');
    expect(screen.getByText('1 unread')).toBeOnTheScreen();
  });

  it('has no badge when everything is read', async () => {
    server.use(
      http.get(apiUrl(NOTIFICATIONS_PATH), () =>
        HttpResponse.json({
          notifications: [message(1, { read_at: '2026-10-16T09:00:00.000Z' })],
          next_cursor: null,
        }),
      ),
    );
    renderWithProviders(<NotificationsScreen />);

    await screen.findByTestId(`notification-${ID(1)}`);
    expect(screen.queryByTestId('notifications-unread-badge')).toBeNull();
  });

  it('keeps the two styles distinct in one place', () => {
    const unread = notificationRowStyle(true);
    const read = notificationRowStyle(false);
    expect(unread.row).toBe('bg-himalaya-dark');
    expect(unread.title).toContain('font-bold');
    expect(read.row).toContain('bg-surface');
    expect(read.title).toContain('font-normal');
  });
});

describe('the inbox follows the pushes (2026-10-21)', () => {
  function Harness() {
    useAppBadge();
    useInboxRefreshOnPush();
    return null;
  }

  it('sets the app icon badge to the unread count, and 0 for a guest', async () => {
    expect(appBadgeCount(true, 4)).toBe(4);
    expect(appBadgeCount(false, 4)).toBe(0);
    expect(appBadgeCount(true, undefined)).toBe(0);

    server.use(http.get(apiUrl(UNREAD_COUNT_PATH), () => HttpResponse.json({ unread: 3 })));
    renderWithProviders(<Harness />);
    await waitFor(() => {
      expect(mockNotifications.badgeCounts.at(-1)).toBe(3);
    });
  });

  it('refetches the unread count the moment a push arrives', async () => {
    let unread = 0;
    server.use(http.get(apiUrl(UNREAD_COUNT_PATH), () => HttpResponse.json({ unread })));
    renderWithProviders(<Harness />);
    await waitFor(() => {
      expect(mockNotifications.badgeCounts.at(-1)).toBe(0);
    });

    unread = 2;
    for (const listener of mockNotifications.receivedListeners) listener({});

    await waitFor(() => {
      expect(mockNotifications.badgeCounts.at(-1)).toBe(2);
    });
  });
});
