import { mmkvStateStorage } from '../storage/mmkv-state-storage';
import { createThemeStore, THEME_STORE_KEY } from '../store/useThemeStore';
import { InMemoryMmkv } from '../test/in-memory-mmkv';
import { applyTheme, bindTheme } from './apply-theme';

const mockSetColorScheme = jest.fn<undefined, [string]>();
jest.mock('nativewind', () => ({
  colorScheme: {
    set: (theme: string) => {
      mockSetColorScheme(theme);
    },
  },
}));

beforeEach(() => {
  jest.clearAllMocks();
});

describe('theme store', () => {
  it('follows the phone until a theme is chosen, and remembers the choice across launches', () => {
    const engine = new InMemoryMmkv();
    const build = () => createThemeStore(mmkvStateStorage(engine));
    expect(build().getState().theme).toBe('system');

    build().getState().setTheme('dark');

    expect(build().getState().theme).toBe('dark');
  });

  it('falls back to the phone setting when what is stored is not a theme', () => {
    const engine = new InMemoryMmkv();
    engine.set(THEME_STORE_KEY, JSON.stringify({ state: { theme: 'sepia' }, version: 1 }));

    expect(createThemeStore(mmkvStateStorage(engine)).getState().theme).toBe('system');
  });
});

describe('applying the theme (NativeWind colorScheme)', () => {
  it.each(['light', 'dark', 'system'] as const)('hands "%s" to NativeWind', (theme) => {
    applyTheme(theme);

    expect(mockSetColorScheme).toHaveBeenCalledWith(theme);
  });

  it('never throws when the theme cannot be applied', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    mockSetColorScheme.mockImplementationOnce(() => {
      throw new Error('appearance unavailable');
    });

    expect(() => {
      applyTheme('dark');
    }).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('applies the stored theme at start and every later change, once each', () => {
    const store = createThemeStore(mmkvStateStorage(new InMemoryMmkv()));
    store.getState().setTheme('light');

    const unbind = bindTheme(store);
    expect(mockSetColorScheme.mock.calls).toEqual([['light']]);

    store.getState().setTheme('dark');
    store.getState().setTheme('dark');
    expect(mockSetColorScheme.mock.calls).toEqual([['light'], ['dark']]);

    unbind();
    store.getState().setTheme('system');
    expect(mockSetColorScheme).toHaveBeenCalledTimes(2);
  });
});
