import { focusManager } from '@tanstack/react-query';
import { AppState, type AppStateStatus } from 'react-native';

/**
 * React Native has no window focus, so React Query never hears that the app came back. This tells
 * it whenever the app returns to the foreground; a query that opted in
 * (`refetchOnWindowFocus: 'always'`, like the category taxonomy) then refetches. Returns the
 * unsubscribe, for the root layout's effect.
 *
 * Opt-in only: the client's default leaves `refetchOnWindowFocus` off, so no other screen starts
 * refetching on every return to the app.
 */
export function bindQueryFocusToAppState(): () => void {
  focusManager.setEventListener((handleFocus) => {
    const subscription = AppState.addEventListener('change', (state: AppStateStatus) => {
      handleFocus(state === 'active');
    });
    return () => {
      subscription.remove();
    };
  });
  return () => {
    focusManager.setEventListener(() => () => undefined);
  };
}
