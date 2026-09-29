import { buildOutgoingMessage, sanitizeChatUser, sanitizeIncomingMessage } from './chat-contract';
import { isDisputeEligible, POST_DELIVERY_WINDOW_MS, postDeliveryDeadline } from './dispute-window';

/** A full user row as a careless server (or a future profile object) might send it. */
const AARAV_FULL = {
  id: 'user-aarav',
  first_name: 'Aarav',
  last_name: 'Sharma',
  phone_number: '+9779800000001',
  phone: '+9779800000001',
  email: 'aarav@example.com',
  role: 'CUSTOMER',
  address: { tole: 'Thamel', exact_lat: 27.7154 },
};

const FORBIDDEN = ['last_name', 'phone_number', 'phone', 'email', 'Sharma', '+9779800000001'];

function expectNoPersonalData(value: unknown): void {
  const json = JSON.stringify(value);
  for (const needle of FORBIDDEN) expect(json).not.toContain(needle);
}

const incoming = (sender: unknown) => ({
  id: 'msg-1',
  client_id: null,
  order_id: 'order-1',
  sender,
  body: 'The honey jar arrived broken.',
  attachments: [
    {
      url: 'https://evidence.hamropasal.test/x.webp',
      content_type: 'image/webp',
      uploader_phone: '+9779800000001',
    },
  ],
  sent_at: '2026-09-29T10:00:00.000Z',
  sender_last_name: 'Sharma',
});

describe('chat privacy filter (SPEC implicit requirement 6)', () => {
  it('reduces a user to id, first name and role', () => {
    expect(sanitizeChatUser(AARAV_FULL)).toEqual({
      id: 'user-aarav',
      first_name: 'Aarav',
      role: 'CUSTOMER',
    });
  });

  it('strips last_name and phone_number from an incoming payload, at every level', () => {
    const message = sanitizeIncomingMessage(incoming(AARAV_FULL));

    expect(message?.sender).toEqual({ id: 'user-aarav', first_name: 'Aarav', role: 'CUSTOMER' });
    expect(message?.attachments).toEqual([
      { url: 'https://evidence.hamropasal.test/x.webp', content_type: 'image/webp' },
    ]);
    expect(message).not.toHaveProperty('sender_last_name');
    expectNoPersonalData(message);
  });

  it('strips last_name and phone_number from an outgoing message', () => {
    const message = buildOutgoingMessage({
      clientId: 'client-1',
      orderId: 'order-1',
      sender: AARAV_FULL,
      body: '  Please refund the honey.  ',
      attachments: [],
      sentAt: new Date('2026-09-29T10:05:00.000Z'),
    });

    expect(message).toEqual({
      id: 'client-1',
      client_id: 'client-1',
      order_id: 'order-1',
      sender: { id: 'user-aarav', first_name: 'Aarav', role: 'CUSTOMER' },
      body: 'Please refund the honey.',
      attachments: [],
      sent_at: '2026-09-29T10:05:00.000Z',
    });
    expectNoPersonalData(message);
  });

  it('keeps a vendor or admin sender to the same allowlist', () => {
    const vendor = sanitizeChatUser({
      id: 'user-ram',
      first_name: 'Ram',
      last_name: 'Shrestha',
      phone_number: '+9779800000011',
      role: 'VENDOR',
    });

    expect(vendor).toEqual({ id: 'user-ram', first_name: 'Ram', role: 'VENDOR' });
  });

  it('keeps a message whose sender has no usable first name, without it', () => {
    const message = sanitizeIncomingMessage(
      incoming({ id: 'admin-1', first_name: 42, role: 'SUPER_ADMIN', phone: '+9779800000099' }),
    );

    expect(message?.sender).toEqual({ id: 'admin-1', first_name: null, role: 'SUPER_ADMIN' });
  });

  it.each([
    ['no sender', { ...incoming(AARAV_FULL), sender: undefined }],
    ['an unknown role', incoming({ ...AARAV_FULL, role: 'HACKER' })],
    [
      'a non-https attachment',
      {
        ...incoming(AARAV_FULL),
        attachments: [{ url: 'http://x.test/a.png', content_type: 'image/png' }],
      },
    ],
    [
      'a non-image attachment',
      {
        ...incoming(AARAV_FULL),
        attachments: [{ url: 'https://x.test/a.exe', content_type: 'application/x-msdownload' }],
      },
    ],
    ['an oversized body', { ...incoming(AARAV_FULL), body: 'x'.repeat(2001) }],
    ['a string instead of an object', 'hello'],
  ])('drops a payload with %s', (_label, payload) => {
    expect(sanitizeIncomingMessage(payload)).toBeNull();
  });
});

describe('48 h post-delivery window', () => {
  const DELIVERED_AT = Date.parse('2026-09-29T10:00:00.000Z');
  const MINUTE = 60_000;
  const HOUR = 60 * MINUTE;

  it('is 48 hours long', () => {
    expect(POST_DELIVERY_WINDOW_MS).toBe(48 * HOUR);
    expect(postDeliveryDeadline(DELIVERED_AT)).toBe(DELIVERED_AT + 48 * HOUR);
    expect(postDeliveryDeadline(null)).toBeNull();
  });

  it.each([
    [0, true],
    [47 * HOUR + 59 * MINUTE, true],
    [48 * HOUR - 1, true],
    [48 * HOUR, false],
    [48 * HOUR + MINUTE, false],
  ])('%p ms after delivery -> eligible %p', (elapsed, expected) => {
    expect(isDisputeEligible('DELIVERED', DELIVERED_AT, DELIVERED_AT + elapsed)).toBe(expected);
  });

  it('applies to delivered orders with a known delivery time only', () => {
    expect(isDisputeEligible('OUT_FOR_DELIVERY', DELIVERED_AT, DELIVERED_AT)).toBe(false);
    expect(isDisputeEligible('DELIVERED', null, DELIVERED_AT)).toBe(false);
  });
});
