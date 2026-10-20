import { focusManager } from '@tanstack/react-query';
import { act, screen, waitFor } from '@testing-library/react-native';
import { http, HttpResponse } from 'msw';
import { AppState, SectionList, type AppStateStatus } from 'react-native';

import FeedScreen from '../../../app/(tabs)/(home)/index';
import { bindQueryFocusToAppState } from '../../api/app-focus';
import { CATEGORIES_PATH, VENDORS_PATH } from '../../api/catalog';
import {
  category,
  categoryList,
  ELECTRONICS_ID,
  feedResponse,
  GROCERIES_ID,
} from '../../test/api-fixtures';
import { apiUrl, server, setupApiTestEnvironment } from '../../test/msw';
import { renderWithProviders } from '../../test/render';

jest.mock('expo-router', () => ({ router: { push: jest.fn() }, useFocusEffect: jest.fn() }));

setupApiTestEnvironment();

/**
 * The "What's on your mind?" row follows the taxonomy without a restart (2026-10-20): a category
 * the Super Admin hides goes away on the next pull to refresh or return to the app.
 */
describe('category row refresh', () => {
  const GROCERIES = category({ id: GROCERIES_ID, name: 'Groceries', slug: 'groceries' });
  const ELECTRONICS = category({
    id: ELECTRONICS_ID,
    name: 'Electronics',
    slug: 'electronics',
    display_order: 1,
  });
  let served = [GROCERIES, ELECTRONICS];
  let requests = 0;

  beforeEach(() => {
    served = [GROCERIES, ELECTRONICS];
    requests = 0;
    server.use(
      http.get(apiUrl(CATEGORIES_PATH), () => {
        requests += 1;
        return HttpResponse.json(categoryList(served));
      }),
      http.get(apiUrl(VENDORS_PATH), () => HttpResponse.json(feedResponse())),
    );
  });

  afterEach(() => {
    focusManager.setFocused(undefined);
  });

  it('drops a category hidden since, on pull to refresh', async () => {
    renderWithProviders(<FeedScreen />);
    expect(await screen.findByTestId(`category-${ELECTRONICS_ID}`)).toBeOnTheScreen();

    // The admin hides Electronics; the customer pulls the list down.
    served = [GROCERIES];
    const list = screen.UNSAFE_getByType(SectionList);
    await act(async () => {
      (list.props as { onRefresh: () => void }).onRefresh();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.queryByTestId(`category-${ELECTRONICS_ID}`)).toBeNull();
    });
    expect(screen.getByTestId(`category-${GROCERIES_ID}`)).toBeOnTheScreen();
  });

  it('drops it when the app comes back to the foreground, however fresh the cache', async () => {
    renderWithProviders(<FeedScreen />);
    expect(await screen.findByTestId(`category-${ELECTRONICS_ID}`)).toBeOnTheScreen();
    const before = requests;

    served = [GROCERIES];
    act(() => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });

    await waitFor(() => {
      expect(screen.queryByTestId(`category-${ELECTRONICS_ID}`)).toBeNull();
    });
    expect(requests).toBe(before + 1);
  });
});

describe('bindQueryFocusToAppState', () => {
  afterEach(() => {
    focusManager.setFocused(undefined);
    jest.restoreAllMocks();
  });

  it('tells React Query when the app goes to the background and comes back', () => {
    let listener: ((state: AppStateStatus) => void) | null = null;
    const remove = jest.fn();
    jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, handler) => {
      listener = handler;
      return { remove };
    });

    const unbind = bindQueryFocusToAppState();
    const emit = (state: AppStateStatus) => {
      if (listener === null) throw new Error('not subscribed');
      listener(state);
    };

    emit('background');
    expect(focusManager.isFocused()).toBe(false);
    emit('active');
    expect(focusManager.isFocused()).toBe(true);

    unbind();
    expect(remove).toHaveBeenCalledTimes(1);
  });
});
