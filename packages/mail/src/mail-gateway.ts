import type { Transporter } from 'nodemailer';

/*
 * Outbound email (step 7.1, decided 2026-10-15: Amazon SES over SMTP). Used by the worker to
 * send queued data exports (SPEC core 11). Every adapter goes through prepareOutboundMail, so no
 * code path sends a message SES would refuse for its size.
 */

export type MailProviderName = 'SES_SMTP' | 'MOCK';

export interface MailAttachment {
  readonly filename: string;
  readonly content: Buffer;
  readonly contentType: string;
}

export interface MailMessage {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly attachments?: readonly MailAttachment[];
}

export interface MailDelivery {
  readonly provider: MailProviderName;
  /** The provider's message id (SES's, through SMTP); null from the mock. */
  readonly messageId: string | null;
}

export interface MailGateway {
  readonly provider: MailProviderName;
  send(message: MailMessage): Promise<MailDelivery>;
}

export class MailDeliveryError extends Error {
  constructor(
    readonly provider: MailProviderName,
    reason: string,
  ) {
    super(`${provider} email failed: ${reason}`);
    this.name = 'MailDeliveryError';
  }
}

/**
 * SES over SMTP refuses a message above 10 MB, and base64 makes an attachment a third larger:
 * 7 MB of attachments is the most that always fits (SPEC core 11: larger exports are linked).
 */
export const MAX_MAIL_ATTACHMENT_BYTES = 7 * 1024 * 1024;
export const MAX_MAIL_SUBJECT_LENGTH = 200;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The single choke point: one plain address, a bounded subject, attachments under the limit. */
export function prepareOutboundMail(message: MailMessage): MailMessage {
  const to = message.to.trim().toLowerCase();
  if (!EMAIL_PATTERN.test(to)) throw new RangeError('Recipient is not an email address');
  const subject = message.subject.trim();
  if (subject.length === 0 || subject.length > MAX_MAIL_SUBJECT_LENGTH || /[\r\n]/.test(subject)) {
    throw new RangeError(
      `Subject must be one line of 1-${String(MAX_MAIL_SUBJECT_LENGTH)} characters`,
    );
  }
  const attachments = message.attachments ?? [];
  const bytes = attachments.reduce((sum, attachment) => sum + attachment.content.length, 0);
  if (bytes > MAX_MAIL_ATTACHMENT_BYTES) {
    throw new RangeError(
      `Attachments total ${String(bytes)} bytes; at most ${String(MAX_MAIL_ATTACHMENT_BYTES)} fit in one email`,
    );
  }
  return { to, subject, text: message.text, attachments };
}

/** Amazon SES through its SMTP interface (nodemailer). The transporter is built from env. */
export class SesSmtpMailGateway implements MailGateway {
  readonly provider = 'SES_SMTP';

  constructor(
    private readonly transporter: Pick<Transporter, 'sendMail'>,
    private readonly from: string,
  ) {}

  async send(message: MailMessage): Promise<MailDelivery> {
    const mail = prepareOutboundMail(message);
    try {
      const info = (await this.transporter.sendMail({
        from: this.from,
        to: mail.to,
        subject: mail.subject,
        text: mail.text,
        attachments: (mail.attachments ?? []).map((attachment) => ({
          filename: attachment.filename,
          content: attachment.content,
          contentType: attachment.contentType,
        })),
      })) as { messageId?: unknown };
      return {
        provider: this.provider,
        messageId: typeof info.messageId === 'string' ? info.messageId : null,
      };
    } catch (error: unknown) {
      throw new MailDeliveryError(
        this.provider,
        error instanceof Error ? error.message : 'unknown',
      );
    }
  }
}

/** In-memory gateway for development and tests. Applies the same rules as the real one. */
export class MockMailGateway implements MailGateway {
  readonly provider = 'MOCK';
  readonly sent: MailMessage[] = [];

  constructor(private readonly onSend?: (message: MailMessage) => void) {}

  // async, so validation failures surface as rejections exactly like the SMTP adapter.
  // eslint-disable-next-line @typescript-eslint/require-await
  async send(message: MailMessage): Promise<MailDelivery> {
    const mail = prepareOutboundMail(message);
    this.sent.push(mail);
    this.onSend?.(mail);
    return { provider: this.provider, messageId: null };
  }
}
