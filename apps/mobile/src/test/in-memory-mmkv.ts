import type { MmkvEngine } from '../storage/mmkv-state-storage';

/** Synchronous in-memory stand-in for an MMKV instance, exposing raw values for assertions. */
export class InMemoryMmkv implements MmkvEngine {
  readonly values = new Map<string, string | number | boolean | ArrayBuffer>();

  getString(key: string): string | undefined {
    const value = this.values.get(key);
    return typeof value === 'string' ? value : undefined;
  }

  set(key: string, value: string | number | boolean | ArrayBuffer): void {
    this.values.set(key, value);
  }

  remove(key: string): boolean {
    return this.values.delete(key);
  }

  clearAll(): void {
    this.values.clear();
  }

  getAllKeys(): string[] {
    return [...this.values.keys()];
  }
}
