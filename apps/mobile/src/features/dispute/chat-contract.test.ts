import { buildOutgoingMessage, sanitizeChatUser, sanitizeIncomingMessage } from './chat-contract';
import {
  CONVERSATION_WINDOW_MS,
  conversationDeadline,
  isConversationOpen,
  POST_DELIVERY_WINDOW_MS,
  postDeliveryDeadline,
} from './dispute-window';

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
      // http(s) only: local development serves evidence over http, but never other schemes.
      'a non-web attachment URL',
      {
        ...incoming(AARAV_FULL),
        attachments: [{ url: 'file:///etc/passwd', content_type: 'image/png' }],
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

  it('closes the conversation 7 days (168 h) after delivery (step 7.3)', () => {
    expect(CONVERSATION_WINDOW_MS).toBe(168 * HOUR);
    expect(conversationDeadline(DELIVERED_AT)).toBe(DELIVERED_AT + 168 * HOUR);
    expect(conversationDeadline(null)).toBeNull();
    expect(MINUTE).toBe(60_000);
  });

  it.each([
    ['PENDING_PAYMENT', null, false, false],
    ['PLACED', null, false, true],
    ['PREPARING', null, false, true],
    ['OUT_FOR_DELIVERY', null, false, true],
    ['DELIVERED', DELIVERED_AT, true, true],
    ['DELIVERED', DELIVERED_AT, false, false],
    ['DELIVERED', null, true, false],
    ['DISPUTED', DELIVERED_AT, false, true],
    ['CANCELED', null, false, false],
    ['FAILED', null, false, false],
  ] as const)('%s (delivered %p, before the end %p) -> open %p', (state, at, before, open) => {
    expect(isConversationOpen(state, at, before)).toBe(open);
  });
});
