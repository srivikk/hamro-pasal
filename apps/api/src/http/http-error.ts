/**
 * An error that already knows its HTTP representation. In its own module so services can extend
 * it without importing errors.ts, which imports the services (a cycle).
 */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}
