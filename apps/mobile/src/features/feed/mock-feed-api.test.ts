import { feedResponseSchema } from './feed-contract';
import { toFeedSections } from './feed-sections';
import { buildFeed, fetchMockFeed, MOCK_CUSTOMER_LOCATION, MOCK_VENDORS } from './mock-feed-api';

const names = (entries: readonly { vendor: { business_name: string } }[]): string[] =>
  entries.map((entry) => entry.vendor.business_name);

describe('mock feed API', () => {
  const feed = buildFeed(MOCK_VENDORS, MOCK_CUSTOMER_LOCATION);

  it('lists serviceable vendors nearest first', () => {
    expect(names(feed.serviceable)).toEqual([
      'Thamel Kirana Pasal',
      'New Road Electronics',
      'Boudha Fresh Mart',
      'Pokhara Dhaka Topi Bhandar',
    ]);
    expect(feed.serviceable.every((entry) => entry.serviceable)).toBe(true);
  });

  it('puts unserviceable vendors in explore_further', () => {
    expect(names(feed.explore_further)).toEqual(['Patan Organic Store', 'Kirtipur Tarkari Pasal']);
    expect(feed.explore_further.every((entry) => !entry.serviceable)).toBe(true);
  });

  it('serves Boudha only because of the 10% GPS drift buffer', () => {
    const boudha = feed.serviceable.find(
      (entry) => entry.vendor.business_name === 'Boudha Fresh Mart',
    );

    expect(boudha?.distance_km).toBeGreaterThan(5);
    expect(boudha?.distance_km).toBeLessThanOrEqual(5.5);
  });

  it('never lists a vendor that is not LIVE', () => {
    const all = names([...feed.serviceable, ...feed.explore_further]);

    expect(all).not.toContain('Bhaktapur Juju Dhau Bhandar');
    expect(all).toHaveLength(MOCK_VENDORS.filter((vendor) => vendor.status === 'LIVE').length);
  });

  it('does not leak the vendor status into the response contract', () => {
    expect(() => feedResponseSchema.parse(feed)).not.toThrow();
  });

  it('resolves asynchronously like a network call', async () => {
    jest.useFakeTimers();
    try {
      const pending = fetchMockFeed(MOCK_CUSTOMER_LOCATION, { latencyMs: 400 });
      jest.advanceTimersByTime(400);

      await expect(pending).resolves.toEqual(feed);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('toFeedSections', () => {
  const feed = buildFeed(MOCK_VENDORS, MOCK_CUSTOMER_LOCATION);

  it('places serviceable vendors above Explore Further', () => {
    const sections = toFeedSections(feed);

    expect(sections.map((section) => section.key)).toEqual(['serviceable', 'explore_further']);
    expect(sections[0]?.data).toEqual(feed.serviceable);
    expect(sections[1]?.data).toEqual(feed.explore_further);
  });

  it('omits Explore Further when every vendor is serviceable', () => {
    expect(toFeedSections({ serviceable: feed.serviceable, explore_further: [] })).toEqual([
      { key: 'serviceable', data: feed.serviceable },
    ]);
  });

  it('keeps an empty serviceable section to carry the empty-state message', () => {
    const sections = toFeedSections({ serviceable: [], explore_further: feed.explore_further });

    expect(sections.map((section) => [section.key, section.data.length])).toEqual([
      ['serviceable', 0],
      ['explore_further', 2],
    ]);
  });

  it('re-files entries by their own serviceable flag', () => {
    const [first] = feed.serviceable;
    const [unreachable] = feed.explore_further;
    if (first === undefined || unreachable === undefined) throw new Error('fixture');

    const sections = toFeedSections({ serviceable: [unreachable], explore_further: [first] });

    expect(sections).toEqual([
      { key: 'serviceable', data: [first] },
      { key: 'explore_further', data: [unreachable] },
    ]);
  });
});
