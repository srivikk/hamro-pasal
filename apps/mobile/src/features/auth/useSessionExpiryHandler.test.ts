import { QueryClient } from '@tanstack/react-query';
import { waitFor } from '@testing-library/react-native';
import { http, HttpResponse } from 'msw';

import { TOKEN_REFRESH_PATH } from '../../api/http';
import { fetchOrder, orderPath } from '../../api/orders';
import { useAuthStore } from '../../store/useAuthStore';
import { useToastStore } from '../../store/useToastStore';
import { errorBody, ORDER_ID } from '../../test/api-fixtures';
import { apiUrl, server, setupApiTestEnvironment } from '../../test/msw';
import { renderHookWithProviders } from '../../test/render';
import { useSessionExpiryHandler } from './useSessionExpiryHandler';

setupApiTestEnvironment();

describe('useSessionExpiryHandler', () => {
  it('clears every cached query and tells the user when the refresh token is refused', async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(['order', ORDER_ID], { previous: 'session data' });
    useToastStore.setState({ toast: null });
    useAuthStore.getState().setSession({ accessToken: 'expired', refreshToken: 'revoked' });
    server.use(
      http.get(apiUrl(orderPath(ORDER_ID)), () =>
        HttpResponse.json(errorBody('UNAUTHENTICATED'), { status: 401 }),
      ),
      http.post(apiUrl(TOKEN_REFRESH_PATH), () =>
        HttpResponse.json(errorBody('REFRESH_TOKEN_INVALID'), { status: 401 }),
      ),
    );
    const { unmount } = renderHookWithProviders(() => {
      useSessionExpiryHandler(queryClient);
    });

    await expect(fetchOrder(ORDER_ID)).rejects.toMatchObject({ status: 401 });

    await waitFor(() => {
      expect(queryClient.getQueryCache().getAll()).toEqual([]);
    });
    expect(useToastStore.getState().toast).toMatchObject({
      message: 'Your session has ended. Please sign in again.',
    });
    expect(useAuthStore.getState()).toMatchObject({ accessToken: null, refreshToken: null });

    // Unsubscribes on unmount.
    unmount();
    queryClient.setQueryData(['order', ORDER_ID], { later: true });
    useAuthStore.getState().setSession({ accessToken: 'expired', refreshToken: 'revoked' });
    await expect(fetchOrder(ORDER_ID)).rejects.toMatchObject({ status: 401 });
    expect(queryClient.getQueryData(['order', ORDER_ID])).toEqual({ later: true });
    queryClient.clear();
  });
});
