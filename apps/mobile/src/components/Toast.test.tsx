import { act, fireEvent, screen } from '@testing-library/react-native';

import { useToastStore } from '../store/useToastStore';
import { renderWithProviders } from '../test/render';
import { TOAST_DURATION_MS, ToastHost } from './Toast';

beforeEach(() => {
  useToastStore.setState({ toast: null });
});

describe('toast store', () => {
  it('replaces the current toast with a newer one', () => {
    useToastStore.getState().show('first', 'info');
    useToastStore.getState().show('second', 'error');

    expect(useToastStore.getState().toast).toMatchObject({ message: 'second', tone: 'error' });
  });

  it('ignores a dismiss for a toast that was already replaced', () => {
    useToastStore.getState().show('first', 'info');
    const firstId = useToastStore.getState().toast?.id ?? -1;
    useToastStore.getState().show('second', 'info');

    useToastStore.getState().dismiss(firstId);

    expect(useToastStore.getState().toast?.message).toBe('second');
  });
});

describe('ToastHost', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('shows the latest toast and hides it after 4 seconds', () => {
    jest.useFakeTimers();
    renderWithProviders(<ToastHost />);

    act(() => {
      useToastStore.getState().show('Payment failed', 'error');
    });
    expect(screen.getByTestId('toast')).toHaveTextContent('Payment failed');

    act(() => {
      jest.advanceTimersByTime(TOAST_DURATION_MS - 1);
    });
    expect(screen.getByTestId('toast')).toBeOnTheScreen();

    act(() => {
      jest.advanceTimersByTime(1);
    });
    expect(screen.queryByTestId('toast')).toBeNull();
  });

  it('restarts the timer for a replacement toast', () => {
    jest.useFakeTimers();
    renderWithProviders(<ToastHost />);

    act(() => {
      useToastStore.getState().show('first', 'info');
    });
    act(() => {
      jest.advanceTimersByTime(TOAST_DURATION_MS - 500);
      useToastStore.getState().show('second', 'info');
    });
    act(() => {
      jest.advanceTimersByTime(TOAST_DURATION_MS - 1);
    });

    expect(screen.getByTestId('toast')).toHaveTextContent('second');
  });

  it('dismisses on tap', () => {
    renderWithProviders(<ToastHost />);
    act(() => {
      useToastStore.getState().show('Tap me', 'success');
    });

    fireEvent.press(screen.getByTestId('toast'));

    expect(screen.queryByTestId('toast')).toBeNull();
  });
});
