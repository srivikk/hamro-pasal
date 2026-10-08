import { feedResponseSchema } from '@hamro-pasal/shared-types';

import { feedResponse, feedVendor } from '../../test/api-fixtures';
import { filterFeedByVendors } from '../discovery/category-shops';
import { sortFeed } from './feed-sort';

/**
 * `delivery_available` (the Emergency Stop flag, STATE_HANDOFF §8Z.23) arrives with the feed. No
 * screen reads it yet; these helpers rebuild the feed and must not drop it on the way.
 */
describe('delivery_available on the feed', () => {
  const stopped = feedResponse({
    serviceable: [],
    explore_further: [
      { vendor: feedVendor(), distance_km: 1, serviceable: false, delivery_available: false },
    ],
    delivery_available: false,
  });

  it('is read as available from an API that predates the field', () => {
    const feed = feedResponseSchema.parse({
      serviceable: [{ vendor: feedVendor(), distance_km: 1, serviceable: true }],
      explore_further: [],
    });

    expect(feed.delivery_available).toBe(true);
    expect(feed.serviceable[0]?.delivery_available).toBe(true);
  });

  it('survives sorting the feed', () => {
    const sorted = sortFeed(stopped, 'rating', () => ({}) as never);

    expect(sorted.delivery_available).toBe(false);
    expect(sorted.explore_further[0]?.delivery_available).toBe(false);
  });

  it('survives filtering the feed to a category’s shops', () => {
    const filtered = filterFeedByVendors(stopped, [feedVendor().id]);

    expect(filtered.delivery_available).toBe(false);
    expect(filtered.explore_further).toHaveLength(1);
    expect(filterFeedByVendors(stopped, []).delivery_available).toBe(false);
  });
});
