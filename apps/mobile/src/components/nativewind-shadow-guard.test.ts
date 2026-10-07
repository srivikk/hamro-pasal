/*
 * Guard for a NativeWind 4 runtime trap. `shadow-*` (and `ring-*`) are implemented with CSS
 * variables. A view whose className gains such a class AFTER its first render is "upgraded" by
 * react-native-css-interop; in development that path prints the view's props with JSON.stringify,
 * which walks into React Navigation objects and throws
 *   "Couldn't find a navigation context. Have you wrapped your app with 'NavigationContainer'?"
 * (seen on a device when a category tile was selected: its shadow was one branch of a ternary).
 *
 * Rule: a shadow / ring class is never one side of a condition. Keep it on in every state and
 * vary border, background or opacity instead.
 */

// Typed structurally: the app's tsconfig does not load Node's type definitions.
const fs = jest.requireActual<{
  readdirSync: (
    path: string,
    options: { withFileTypes: true },
  ) => {
    name: string;
    isDirectory: () => boolean;
  }[];
  readFileSync: (path: string, encoding: 'utf8') => string;
}>('node:fs');
const path = jest.requireActual<{ join: (...parts: string[]) => string }>('node:path');

// Jest's own global; declared here because Node's types are not loaded.
declare const __dirname: string;

const APP_ROOT = path.join(__dirname, '..', '..');

function sourceFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.name.endsWith('.tsx') && !entry.name.endsWith('.test.tsx') ? [full] : [];
  });
}

/** A string literal holding a shadow / ring class directly after `?` or `:` (a ternary branch). */
const CONDITIONAL_SHADOW = /[?:]\s*(['"`])[^'"`]*\b(?:shadow|ring)(?:-[a-z0-9]+)?\b[^'"`]*\1/;

describe('NativeWind: shadow classes are never conditional', () => {
  it('recognises the pattern that crashed, and accepts the fix', () => {
    expect(
      CONDITIONAL_SHADOW.test("selected ? 'border-2 border-brand' : 'bg-white shadow-sm'"),
    ).toBe(true);
    expect(CONDITIONAL_SHADOW.test("active ? 'shadow-md' : ''")).toBe(true);
    expect(
      CONDITIONAL_SHADOW.test(
        "`rounded-full border-2 shadow-sm ${selected ? 'border-brand' : 'border-transparent'}`",
      ),
    ).toBe(false);
  });

  it('holds for every screen and component', () => {
    const offenders = [path.join(APP_ROOT, 'app'), path.join(APP_ROOT, 'src')]
      .flatMap(sourceFiles)
      .flatMap((file) =>
        fs
          .readFileSync(file, 'utf8')
          .split('\n')
          .flatMap((line, index) =>
            CONDITIONAL_SHADOW.test(line) ? [`${file}:${String(index + 1)}: ${line.trim()}`] : [],
          ),
      );

    expect(offenders).toEqual([]);
  });
});
