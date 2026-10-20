import type { IrdLookupResult, IrdPanLookup } from './ird-lookup';

/*
 * IRD_VERIFICATION_PROVIDER=MOCK (and MOCK_SERVICES=true): answers without any network, so a local
 * run exercises the whole pipeline. Refused in production. By the PAN's last digit:
 *
 *   0 → NOT_FOUND (the IRD's "invalid information")
 *   9 → FOUND under another business's name (a name mismatch)
 *   8 → FOUND, but every registration is Closed (an inactive account)
 *   7 → the page changed (LAYOUT_CHANGED)
 *   anything else → FOUND under the name `nameOf(pan)` gives (the vendor's own: a match)
 */
export class MockIrdLookup implements IrdPanLookup {
  constructor(private readonly nameOf: (pan: string) => Promise<string | null>) {}

  async lookup(pan: string): Promise<IrdLookupResult> {
    console.info(`[ird:mock] looking up PAN ${pan}`);
    switch (pan.at(-1)) {
      case '0':
        return { kind: 'NOT_FOUND' };
      case '9':
        return {
          kind: 'FOUND',
          businessName: 'Himalayan Unrelated Trading Concern',
          registrationDate: '2075-04-01',
          accountStatuses: ['Active'],
        };
      case '8':
        return {
          kind: 'FOUND',
          businessName: (await this.nameOf(pan)) ?? '',
          registrationDate: '2070-01-15',
          accountStatuses: ['Closed'],
        };
      case '7':
        return { kind: 'LAYOUT_CHANGED', detail: 'mock: the search form is not as expected' };
      default:
        return {
          kind: 'FOUND',
          businessName: (await this.nameOf(pan)) ?? '',
          registrationDate: '2078-09-10',
          accountStatuses: ['Active'],
        };
    }
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}
