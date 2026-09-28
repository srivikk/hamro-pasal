export type Closer = () => Promise<void>;

/**
 * Collects resources to release on shutdown. `close()` runs closers in reverse
 * registration order, is idempotent, and reports every failure instead of stopping at the first.
 */
export class Lifecycle {
  private readonly closers: Closer[] = [];
  private closing: Promise<void> | undefined;

  register(closer: Closer): void {
    this.closers.push(closer);
  }

  close(): Promise<void> {
    this.closing ??= this.runClosers();
    return this.closing;
  }

  private async runClosers(): Promise<void> {
    const errors: unknown[] = [];
    for (const closer of [...this.closers].reverse()) {
      try {
        await closer();
      } catch (error: unknown) {
        errors.push(error);
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, 'One or more resources failed to close');
    }
  }
}
