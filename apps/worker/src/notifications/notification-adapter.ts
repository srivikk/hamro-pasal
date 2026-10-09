/**
 * One notice to one shop, already worded: the SMS text and the push it is sent beside. The
 * adapter only delivers; what is said, and to whom, is decided before it (vendor-notices.ts).
 */
export interface VendorNotice {
  /** The domain event the notice is about; with `vendorId` it identifies the notice. */
  readonly eventId: string;
  readonly eventType: string;
  readonly vendorId: string;
  /** The shop's +977 business number. */
  readonly phone: string;
  readonly sms: string;
  readonly push: { readonly title: string; readonly body: string };
}

/**
 * Where vendor notices leave the worker (Phase 36). Throwing means "not delivered": the consumer
 * releases its claim for that shop and the message is retried, then dead-lettered.
 *
 * The only implementation today is the logger below. A real one sends `sms` through
 * `@hamro-pasal/sms` (the SMS_PROVIDER adapters the login code and the debt notices already use)
 * and `push` through the Expo gateway to the devices of `vendors.user_id`.
 */
export interface NotificationAdapter {
  readonly name: string;
  send(notice: VendorNotice): Promise<void>;
}

export const SMS_LOG_PREFIX = '[notify:sms]';
export const PUSH_LOG_PREFIX = '[notify:push]';

/** The two lines the logger writes for a notice. */
export function noticeLogLines(notice: VendorNotice): [string, string] {
  return [
    `${SMS_LOG_PREFIX} to ${notice.phone}: ${notice.sms}`,
    `${PUSH_LOG_PREFIX} to vendor ${notice.vendorId}: ${notice.push.title} | ${notice.push.body}`,
  ];
}

/** Writes each notice to the worker's standard output instead of sending it. No network call. */
export class LoggerNotificationAdapter implements NotificationAdapter {
  readonly name = 'LOGGER';

  constructor(
    private readonly log: (line: string) => void = (line) => {
      console.log(line);
    },
  ) {}

  send(notice: VendorNotice): Promise<void> {
    for (const line of noticeLogLines(notice)) this.log(line);
    return Promise.resolve();
  }
}
