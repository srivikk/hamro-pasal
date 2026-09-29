import type { FeedEntry, FeedResponse } from './feed-contract';

export type FeedSectionKey = 'serviceable' | 'explore_further';

export interface FeedSection {
  key: FeedSectionKey;
  data: FeedEntry[];
}

/**
 * SPEC customer flow step 3: serviceable vendors first, then "Explore Further". The serviceable
 * section is always present (it carries the empty-state message); Explore Further only when non-empty.
 * Entries are re-checked against their `serviceable` flag, so a misfiled entry can never show an
 * enabled cart in Explore Further or a disabled one at the top.
 */
export function toFeedSections(feed: FeedResponse): FeedSection[] {
  const all = [...feed.serviceable, ...feed.explore_further];
  const serviceable = all.filter((entry) => entry.serviceable);
  const exploreFurther = all.filter((entry) => !entry.serviceable);

  const sections: FeedSection[] = [{ key: 'serviceable', data: serviceable }];
  if (exploreFurther.length > 0) sections.push({ key: 'explore_further', data: exploreFurther });
  return sections;
}
