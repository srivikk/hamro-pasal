import type { ServerEnv } from '@hamro-pasal/shared-types';
import { createTransport } from 'nodemailer';

import {
  MockMailGateway,
  SesSmtpMailGateway,
  type MailGateway,
  type MailMessage,
} from './mail-gateway';

/** A slow SMTP server must not hold a worker job for long. */
export const SMTP_TIMEOUT_MS = 15_000;

/** `[mail:mock] to a@b.np: <subject> (2 attachments)`: no body, so an export never reaches a log. */
export function mockMailLogLine(message: MailMessage): string {
  const count = message.attachments?.length ?? 0;
  return `[mail:mock] to ${message.to}: ${message.subject} (${String(count)} attachment${count === 1 ? '' : 's'})`;
}

export interface MailGatewayFromEnvOptions {
  readonly mockLog?: (line: string) => void;
}

/**
 * MAIL_PROVIDER: SES_SMTP (STARTTLS on 587, or implicit TLS on 465), MOCK, or DISABLED (null:
 * nothing can be emailed, and queued exports are refused). The env schema already requires the
 * SES keys for SES_SMTP and refuses MOCK in production.
 */
export function mailGatewayFromEnv(
  env: Pick<
    ServerEnv,
    | 'MAIL_PROVIDER'
    | 'SES_SMTP_HOST'
    | 'SES_SMTP_PORT'
    | 'SES_SMTP_USER'
    | 'SES_SMTP_PASSWORD'
    | 'MAIL_FROM'
  >,
  options: MailGatewayFromEnvOptions = {},
): MailGateway | null {
  switch (env.MAIL_PROVIDER) {
    case 'DISABLED':
      return null;
    case 'MOCK': {
      const log =
        options.mockLog ??
        ((line: string) => {
          console.info(line);
        });
      return new MockMailGateway((message) => {
        log(mockMailLogLine(message));
      });
    }
    case 'SES_SMTP': {
      const { SES_SMTP_HOST, SES_SMTP_USER, SES_SMTP_PASSWORD, MAIL_FROM } = env;
      if (
        SES_SMTP_HOST === undefined ||
        SES_SMTP_USER === undefined ||
        SES_SMTP_PASSWORD === undefined ||
        MAIL_FROM === undefined
      ) {
        throw new Error(
          'MAIL_PROVIDER=SES_SMTP needs SES_SMTP_HOST, SES_SMTP_USER, SES_SMTP_PASSWORD and MAIL_FROM',
        );
      }
      const transporter = createTransport({
        host: SES_SMTP_HOST,
        port: env.SES_SMTP_PORT,
        secure: env.SES_SMTP_PORT === 465,
        requireTLS: env.SES_SMTP_PORT !== 465,
        auth: { user: SES_SMTP_USER, pass: SES_SMTP_PASSWORD },
        connectionTimeout: SMTP_TIMEOUT_MS,
        greetingTimeout: SMTP_TIMEOUT_MS,
        socketTimeout: SMTP_TIMEOUT_MS,
      });
      return new SesSmtpMailGateway(transporter, MAIL_FROM);
    }
  }
}
