import { createTransport } from 'nodemailer';

import { mailGatewayFromEnv, mockMailLogLine } from './from-env';
import {
  MAX_MAIL_ATTACHMENT_BYTES,
  MailDeliveryError,
  MockMailGateway,
  prepareOutboundMail,
  SesSmtpMailGateway,
} from './mail-gateway';

const csv = (bytes: number) => ({
  filename: 'statement.csv.zip',
  content: Buffer.alloc(bytes, 0x41),
  contentType: 'application/zip',
});

const ses = {
  MAIL_PROVIDER: 'SES_SMTP' as const,
  SES_SMTP_HOST: 'email-smtp.ap-south-1.amazonaws.com',
  SES_SMTP_PORT: 587,
  SES_SMTP_USER: 'AKIAEXAMPLE',
  SES_SMTP_PASSWORD: 'smtp-password',
  MAIL_FROM: 'exports@hamropasal.np',
};

describe('prepareOutboundMail', () => {
  it('lower-cases the recipient and trims the subject', () => {
    expect(
      prepareOutboundMail({ to: ' Sita@Example.COM ', subject: '  Your export ', text: 'x' }),
    ).toMatchObject({ to: 'sita@example.com', subject: 'Your export', attachments: [] });
  });

  it('refuses a bad address, an empty or multi-line subject (header injection)', () => {
    for (const message of [
      { to: 'not-an-email', subject: 'S', text: '' },
      { to: 'a@b.np, c@d.np', subject: 'S', text: '' },
      { to: 'a@b.np', subject: '   ', text: '' },
      { to: 'a@b.np', subject: 'S\r\nBcc: everyone@x.np', text: '' },
    ]) {
      expect(() => prepareOutboundMail(message)).toThrow(RangeError);
    }
  });

  it('takes attachments up to 7 MB in total and refuses one byte more', () => {
    const at = (bytes: number) => ({
      to: 'a@b.np',
      subject: 'S',
      text: '',
      attachments: [csv(bytes)],
    });
    expect(() => prepareOutboundMail(at(MAX_MAIL_ATTACHMENT_BYTES))).not.toThrow();
    expect(() => prepareOutboundMail(at(MAX_MAIL_ATTACHMENT_BYTES + 1))).toThrow(/at most/);
    // 7 MB of attachments stays under SES's 10 MB message limit once base64-encoded.
    expect(Math.ceil((MAX_MAIL_ATTACHMENT_BYTES * 4) / 3)).toBeLessThan(10 * 1024 * 1024);
  });
});

describe('SesSmtpMailGateway', () => {
  it('builds the SMTP message with the attachment, from the configured sender', async () => {
    const transporter = createTransport({ streamTransport: true, buffer: true, newline: 'unix' });
    const sendMail = jest.spyOn(transporter, 'sendMail');
    const gateway = new SesSmtpMailGateway(transporter, 'exports@hamropasal.np');

    const delivery = await gateway.send({
      to: 'Owner@Shop.np',
      subject: 'Your statement',
      text: 'Attached.',
      attachments: [csv(10)],
    });

    expect(delivery.provider).toBe('SES_SMTP');
    const raw = String(((await sendMail.mock.results[0]?.value) as { message: Buffer }).message);
    expect(raw).toContain('From: exports@hamropasal.np');
    expect(raw).toContain('To: owner@shop.np');
    expect(raw).toContain('Subject: Your statement');
    expect(raw).toContain('filename=statement.csv.zip');
    expect(raw).toContain('Content-Type: application/zip');
  });

  it('turns an SMTP failure (refused, timed out) into a MailDeliveryError', async () => {
    const gateway = new SesSmtpMailGateway(
      { sendMail: () => Promise.reject(new Error('Greeting never received')) },
      'exports@hamropasal.np',
    );
    await expect(gateway.send({ to: 'a@b.np', subject: 'S', text: '' })).rejects.toThrow(
      new MailDeliveryError('SES_SMTP', 'Greeting never received'),
    );
  });

  it('never calls SMTP for a message it refuses', async () => {
    const sendMail = jest.fn();
    const gateway = new SesSmtpMailGateway({ sendMail }, 'exports@hamropasal.np');
    await expect(gateway.send({ to: 'bad', subject: 'S', text: '' })).rejects.toThrow(RangeError);
    expect(sendMail).not.toHaveBeenCalled();
  });
});

describe('mailGatewayFromEnv', () => {
  it('is null when DISABLED, the mock for MOCK, SES for SES_SMTP', () => {
    expect(mailGatewayFromEnv({ ...ses, MAIL_PROVIDER: 'DISABLED' })).toBeNull();
    expect(mailGatewayFromEnv({ ...ses, MAIL_PROVIDER: 'MOCK' })).toBeInstanceOf(MockMailGateway);
    expect(mailGatewayFromEnv(ses)).toBeInstanceOf(SesSmtpMailGateway);
  });

  it('refuses SES_SMTP without its settings', () => {
    expect(() => mailGatewayFromEnv({ ...ses, SES_SMTP_PASSWORD: undefined })).toThrow(/SES_SMTP/);
  });

  it('logs the mock without the body', async () => {
    const lines: string[] = [];
    const gateway = mailGatewayFromEnv(
      { ...ses, MAIL_PROVIDER: 'MOCK' },
      { mockLog: (line) => lines.push(line) },
    );
    await gateway?.send({
      to: 'a@b.np',
      subject: 'Export ready',
      text: 'secret rows',
      attachments: [csv(5)],
    });
    expect(lines).toEqual(['[mail:mock] to a@b.np: Export ready (1 attachment)']);
    expect(mockMailLogLine({ to: 'a@b.np', subject: 'S', text: '' })).toBe(
      '[mail:mock] to a@b.np: S (0 attachments)',
    );
  });
});
