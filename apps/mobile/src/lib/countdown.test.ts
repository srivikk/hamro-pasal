import { formatCountdown, remainingMs } from './countdown';

describe('remainingMs', () => {
  const now = Date.parse('2026-09-29T10:00:00.000Z');

  it('counts down to the expiry', () => {
    expect(remainingMs('2026-09-29T10:10:00.000Z', now)).toBe(600_000);
  });

  it('never goes below zero', () => {
    expect(remainingMs('2026-09-29T09:59:00.000Z', now)).toBe(0);
  });

  it('treats a missing or unparsable expiry as expired', () => {
    expect(remainingMs(null, now)).toBe(0);
    expect(remainingMs('not a date', now)).toBe(0);
  });
});

describe('formatCountdown', () => {
  it.each([
    [600_000, '10:00'],
    [599_001, '10:00'],
    [65_000, '01:05'],
    [1, '00:01'],
    [0, '00:00'],
    [-5, '00:00'],
  ])('formats %p ms as %p', (ms, expected) => {
    expect(formatCountdown(ms, 'en')).toBe(expected);
  });

  it('uses Devanagari digits under ne', () => {
    expect(formatCountdown(65_000, 'ne')).toBe('०१:०५');
    expect(formatCountdown(600_000, 'ne')).toBe('१०:००');
  });
});
