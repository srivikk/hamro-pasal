import { feedResponseSchema, type FeedEntry } from '@hamro-pasal/shared-types';
import { screen } from '@testing-library/react-native';

import { VendorCard } from '../../components/VendorCard';
import { feedResponse } from '../../test/api-fixtures';
import { renderWithProviders } from '../../test/render';
import type { VendorExtras } from '../promo/promo-model';
import { sortFeed } from './feed-sort';

/** SPEC core 8, "Sponsored feed listings": the server flags at most two entries, placed first. */
describe('sponsored feed entries', () => {
  const base = feedResponse().serviceable[0];
  if (base === undefined) throw new Error('fixture');
  const entry = (id: string, distanceKm: number, sponsored: boolean): FeedEntry => ({
    ...base,
    vendor: { ...base.vendor, id },
    distance_km: distanceKm,
    is_sponsored: sponsored,
  });
  const A = '11111111-1111-4111-8111-111111111111';
  const B = '22222222-2222-4222-8222-222222222222';
  const C = '33333333-3333-4333-8333-333333333333';

  it('reads an answer from before the field as "not an ad"', () => {
    const { is_sponsored: _flag, ...older } = entry(A, 1, true);
    const parsed = feedResponseSchema.parse({ serviceable: [older], explore_further: [] });
    expect(parsed.serviceable[0]?.is_sponsored).toBe(false);
  });

  it('keeps the sponsored entries first whatever the sort', () => {
    const feed = feedResponseSchema.parse({
      serviceable: [entry(C, 3, true), entry(B, 2, false), entry(A, 1, false)],
      explore_further: [],
    });
    const ratings: Record<string, number> = { [A]: 3, [B]: 5, [C]: 1 };
    const extrasOf = (vendor: { id: string }) =>
      ({ rating_average: ratings[vendor.id] ?? null }) as VendorExtras;

    const sorted = sortFeed(feed, 'rating', extrasOf);

    expect(sorted.serviceable.map((each) => each.vendor.id)).toEqual([C, B, A]);
    expect(sortFeed(feed, 'relevance', extrasOf)).toBe(feed);
  });

  it('shows the "Ad" badge exactly on an entry the server flagged', () => {
    const view = renderWithProviders(<VendorCard entry={entry(A, 1, true)} onPress={jest.fn()} />);
    expect(screen.getByTestId(`vendor-ad-${A}`)).toBeOnTheScreen();
    view.unmount();

    renderWithProviders(<VendorCard entry={entry(B, 1, false)} onPress={jest.fn()} />);
    expect(screen.queryByTestId(`vendor-ad-${B}`)).toBeNull();
  });
});
