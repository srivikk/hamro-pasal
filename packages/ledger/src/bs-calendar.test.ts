import { bsDateOf, bsMonthStart, nextBsMonthStart } from './bs-calendar';

describe('Bikram Sambat calendar (Nepal Time)', () => {
  it('converts the pinned pair: 7 October 2025 is 21 Ashwin 2082', () => {
    expect(bsDateOf(new Date('2025-10-07T06:00:00+05:45'))).toEqual({
      year: 2082,
      month: 6,
      day: 21,
    });
  });

  it('decides the date in Nepal Time, not UTC', () => {
    // 18:15 UTC is midnight in Nepal: the next BS day has begun.
    expect(bsDateOf(new Date('2025-10-07T18:14:59Z')).day).toBe(21);
    expect(bsDateOf(new Date('2025-10-07T18:15:00Z')).day).toBe(22);
  });

  it('starts a month at 00:00 Nepal Time on its 1st', () => {
    // 1 Kartik 2082 is 18 October 2025; 1 Shrawan 2082 (the fiscal year) is 17 July 2025.
    expect(bsMonthStart(2082, 7).toISOString()).toBe('2025-10-17T18:15:00.000Z');
    expect(bsMonthStart(2082, 4).toISOString()).toBe('2025-07-16T18:15:00.000Z');
    expect(bsDateOf(bsMonthStart(2082, 7))).toEqual({ year: 2082, month: 7, day: 1 });
  });

  it('ends a cycle at the first instant of the next BS month, whatever the month length', () => {
    const end = nextBsMonthStart(new Date('2025-10-07T06:00:00+05:45'));
    expect(end.toISOString()).toBe('2025-10-17T18:15:00.000Z');
    // The last instant of a month and its first instant fall in different cycles.
    expect(nextBsMonthStart(new Date(end.getTime() - 1))).toEqual(end);
    expect(nextBsMonthStart(end).getTime()).toBeGreaterThan(end.getTime());
    expect(bsDateOf(nextBsMonthStart(end))).toEqual({ year: 2082, month: 8, day: 1 });
  });

  it('rolls over the BS year after Chaitra and always moves forward by 29 to 32 days', () => {
    expect(bsDateOf(nextBsMonthStart(bsMonthStart(2082, 12)))).toEqual({
      year: 2083,
      month: 1,
      day: 1,
    });
    let start = bsMonthStart(2082, 1);
    for (let i = 0; i < 24; i += 1) {
      const next = nextBsMonthStart(start);
      const days = (next.getTime() - start.getTime()) / 86_400_000;
      expect(days).toBeGreaterThanOrEqual(29);
      expect(days).toBeLessThanOrEqual(32);
      expect(bsDateOf(next).day).toBe(1);
      start = next;
    }
  });
});
