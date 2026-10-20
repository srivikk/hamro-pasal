/*
 * The IRD PAN lookup as the verification state machine sees it (2026-10-21). One adapter per way of
 * asking the IRD: the headless browser over its public PAN search (playwright-ird-lookup.ts), and a
 * mock for local runs and tests. The state machine (ird-pan-verification.ts) decides what each
 * answer means for the vendor; an adapter only reports what the IRD said.
 */

/** What one lookup found. */
export type IrdLookupResult =
  | {
      readonly kind: 'FOUND';
      /** The trade name the IRD holds (English, else Nepali); '' when it shows none. */
      readonly businessName: string;
      /** "Effective Registration Date" as the IRD prints it (a BS date), or null. */
      readonly registrationDate: string | null;
      /** The status of each registration under the PAN ("Active", "Closed", "Deactive" …). */
      readonly accountStatuses: readonly string[];
    }
  /** The IRD answered "invalid information" (अवैध जानकारी): no such PAN, or the CAPTCHA was refused. */
  | { readonly kind: 'NOT_FOUND' }
  /** The page or the result is not shaped as the parser expects. Not retried: a person must look. */
  | { readonly kind: 'LAYOUT_CHANGED'; readonly detail: string };

export interface IrdPanLookup {
  /** Looks one PAN up. Throws IrdTransientError (or any error) for an attempt worth retrying. */
  lookup(pan: string): Promise<IrdLookupResult>;
  /** Frees the browser, if any. */
  close(): Promise<void>;
}

/** A failure another attempt may not repeat: a timeout, the network, the CAPTCHA service. */
export class IrdTransientError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'IrdTransientError';
  }
}

/** Rejects with IrdTransientError when `work` has not settled within `ms`. */
export async function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new IrdTransientError(`${what} timed out after ${String(ms / 1000)} s`));
    }, ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
