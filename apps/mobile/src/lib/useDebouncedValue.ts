import { useEffect, useState } from 'react';

/**
 * Follows `value`, but only after it has stayed unchanged for `delayMs`: every change restarts the
 * wait, so a burst of changes (typing) yields one update with the last value.
 */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebounced(value);
    }, delayMs);
    return () => {
      clearTimeout(timer);
    };
  }, [value, delayMs]);

  return debounced;
}
