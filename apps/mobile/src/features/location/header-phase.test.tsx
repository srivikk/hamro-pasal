import { act, renderHook, screen } from '@testing-library/react-native';
import { AppState, Text, type AppStateStatus } from 'react-native';

import { renderWithProviders } from '../../test/render';
import { HeaderGradient } from './HeaderGradient';
import {
  HEADER_THEMES,
  headerPhaseAt,
  useHeaderPhase,
  useHeaderTone,
  type HeaderPhase,
} from './header-phase';

jest.mock('expo-router', () => ({ router: { push: jest.fn() } }));

function Tone() {
  return <Text testID="tone">{useHeaderTone()}</Text>;
}

describe('headerPhaseAt', () => {
  it.each<[number, HeaderPhase]>([
    [0, 'night'],
    [4, 'night'],
    [5, 'morning'],
    [11, 'morning'],
    [12, 'afternoon'],
    [16, 'afternoon'],
    [17, 'evening'],
    [19, 'evening'],
    [20, 'night'],
    [23, 'night'],
  ])('%i:00 is %s', (hour, phase) => {
    expect(headerPhaseAt(hour)).toBe(phase);
  });
});

describe('header themes', () => {
  it('uses dark text by day and light text at night', () => {
    expect(
      (['morning', 'afternoon', 'evening', 'night'] as const).map(
        (phase) => HEADER_THEMES[phase].tone,
      ),
    ).toEqual(['dark', 'dark', 'dark', 'light']);
  });

  it('fades the day phases into the screen background, and keeps the night dark throughout', () => {
    for (const phase of ['morning', 'afternoon', 'evening'] as const) {
      expect(HEADER_THEMES[phase].colors.at(-1)).toBe('#F9FAFB');
    }
    expect(HEADER_THEMES.night.colors).not.toContain('#F9FAFB');
  });

  it('gives every colour a position', () => {
    for (const theme of Object.values(HEADER_THEMES)) {
      expect(theme.locations).toHaveLength(theme.colors.length);
    }
  });
});

describe('useHeaderPhase', () => {
  const at = (hour: number) => new Date(2026, 9, 6, hour, 30);

  it('follows the clock every minute and when the app returns to the foreground', () => {
    jest.useFakeTimers();
    const listeners: ((state: AppStateStatus) => void)[] = [];
    const spy = jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, listener) => {
      listeners.push(listener);
      return { remove: jest.fn() };
    });
    let hour = 16;
    try {
      const { result } = renderHook(() => useHeaderPhase(() => at(hour)));
      expect(result.current).toBe('afternoon');

      hour = 17;
      act(() => {
        jest.advanceTimersByTime(60_000);
      });
      expect(result.current).toBe('evening');

      hour = 20;
      act(() => {
        for (const listener of listeners) listener('active');
      });
      expect(result.current).toBe('night');
    } finally {
      spy.mockImplementation(() => ({ remove: jest.fn() }));
      jest.useRealTimers();
    }
  });
});

describe('HeaderGradient', () => {
  it('shows stars and switches its content to light text at night', () => {
    renderWithProviders(
      <HeaderGradient phase="night">
        <Tone />
      </HeaderGradient>,
    );

    expect(screen.getByTestId('header-stars')).toBeOnTheScreen();
    expect(screen.getAllByTestId('header-star').length).toBeGreaterThanOrEqual(12);
    expect(screen.getAllByTestId('header-star').length).toBeLessThanOrEqual(15);
    expect(screen.getByTestId('tone')).toHaveTextContent('light');
  });

  it.each(['morning', 'afternoon', 'evening'] as const)(
    'has no stars and dark text in the %s',
    (phase) => {
      renderWithProviders(
        <HeaderGradient phase={phase}>
          <Tone />
        </HeaderGradient>,
      );

      expect(screen.queryByTestId('header-stars')).toBeNull();
      expect(screen.getByTestId('tone')).toHaveTextContent('dark');
    },
  );

  it('is dark-toned for anything drawn outside a header', () => {
    renderWithProviders(<Tone />);

    expect(screen.getByTestId('tone')).toHaveTextContent('dark');
  });
});
