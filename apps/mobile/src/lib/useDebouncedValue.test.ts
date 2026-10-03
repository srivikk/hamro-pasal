import { act, renderHook } from '@testing-library/react-native';

import { useDebouncedValue } from './useDebouncedValue';

describe('useDebouncedValue', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  const advance = (ms: number): void => {
    act(() => {
      jest.advanceTimersByTime(ms);
    });
  };

  it('starts with the given value, without waiting', () => {
    const { result } = renderHook(() => useDebouncedValue('wai', 300));

    expect(result.current).toBe('wai');
  });

  it('follows a change only once the delay has fully passed', () => {
    const { result, rerender } = renderHook(
      ({ value }: { value: string }) => useDebouncedValue(value, 300),
      {
        initialProps: { value: '' },
      },
    );

    rerender({ value: 'tea' });
    advance(299);
    expect(result.current).toBe('');

    advance(1);
    expect(result.current).toBe('tea');
  });

  it('restarts the wait on every change, so a burst yields only the last value', () => {
    const seen: string[] = [];
    const { result, rerender } = renderHook(
      ({ value }: { value: string }) => {
        const debounced = useDebouncedValue(value, 300);
        if (seen.at(-1) !== debounced) seen.push(debounced);
        return debounced;
      },
      { initialProps: { value: '' } },
    );

    for (const typed of ['w', 'wa', 'wai', 'wai ', 'wai w']) {
      rerender({ value: typed });
      advance(200);
    }
    // 1000 ms of typing, never 300 ms at rest: nothing has come through yet.
    expect(result.current).toBe('');

    advance(100);
    expect(result.current).toBe('wai w');
    expect(seen).toEqual(['', 'wai w']);
  });

  it('does not update after a change back to the current value', () => {
    const { result, rerender } = renderHook(
      ({ value }: { value: string }) => useDebouncedValue(value, 300),
      {
        initialProps: { value: 'tea' },
      },
    );

    rerender({ value: 'teas' });
    advance(100);
    rerender({ value: 'tea' });
    advance(300);

    expect(result.current).toBe('tea');
  });

  it('drops its pending update when unmounted', () => {
    const { rerender, unmount } = renderHook(
      ({ value }: { value: string }) => useDebouncedValue(value, 300),
      {
        initialProps: { value: '' },
      },
    );
    rerender({ value: 'tea' });

    unmount();

    expect(jest.getTimerCount()).toBe(0);
  });

  it('uses the delay it is given', () => {
    const { result, rerender } = renderHook(
      ({ value }: { value: number }) => useDebouncedValue(value, 50),
      {
        initialProps: { value: 1 },
      },
    );

    rerender({ value: 2 });
    advance(50);

    expect(result.current).toBe(2);
  });
});
