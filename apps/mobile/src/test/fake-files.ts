/*
 * Stand-ins for expo-file-system and expo-sharing (both native). Tests read what was written and
 * shared through `mockFiles`. Registered for every test file in jest.setup.ts.
 */

export const mockFiles: {
  /** Files written, by uri. */
  written: Map<string, Uint8Array>;
  /** Every shareAsync call, in order. */
  shared: { uri: string; options: unknown }[];
  /** What Sharing.isAvailableAsync answers. */
  sharingAvailable: boolean;
  reset(): void;
} = {
  written: new Map(),
  shared: [],
  sharingAvailable: true,
  reset() {
    this.written.clear();
    this.shared = [];
    this.sharingAvailable = true;
  },
};

const CACHE_URI = 'file:///cache';

export class File {
  readonly uri: string;

  constructor(...parts: (string | { uri: string })[]) {
    this.uri = parts.map((part) => (typeof part === 'string' ? part : part.uri)).join('/');
  }

  create(): void {
    mockFiles.written.set(this.uri, new Uint8Array());
  }

  write(content: Uint8Array): void {
    mockFiles.written.set(this.uri, content);
  }
}

export const Paths = { cache: { uri: CACHE_URI } };

export function isAvailableAsync(): Promise<boolean> {
  return Promise.resolve(mockFiles.sharingAvailable);
}

export function shareAsync(uri: string, options?: unknown): Promise<void> {
  mockFiles.shared.push({ uri, options });
  return Promise.resolve();
}
