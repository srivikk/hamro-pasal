/*
 * 2026-10-21 (Task 4): the two states of a message in the notification centre, kept apart from
 * the screen so each class is asserted in one place.
 *
 *   unread  a dark background (deep Himalaya blue, in both colour schemes), bold white title,
 *           light body, a marigold dot
 *   read    a light background (the plain surface; the muted dark surface under dark mode),
 *           regular-weight title in ink
 *
 * White on himalaya-dark (#1A3F9C) is about 9:1, above WCAG AA for any text size.
 */

export interface NotificationRowStyle {
  readonly row: string;
  readonly title: string;
  readonly body: string;
  readonly time: string;
  readonly dot: string;
}

const UNREAD: NotificationRowStyle = {
  row: 'bg-himalaya-dark',
  title: 'font-bold text-white',
  body: 'text-white/90',
  time: 'text-white/75',
  dot: 'bg-marigold',
};

const READ: NotificationRowStyle = {
  row: 'border border-line bg-surface dark:border-line-dark dark:bg-surface-dark-muted',
  title: 'font-normal text-ink dark:text-ink-dark',
  body: 'text-ink-muted dark:text-ink-dark-muted',
  time: 'text-ink-muted dark:text-ink-dark-muted',
  dot: 'bg-transparent',
};

export function notificationRowStyle(unread: boolean): NotificationRowStyle {
  return unread ? UNREAD : READ;
}
