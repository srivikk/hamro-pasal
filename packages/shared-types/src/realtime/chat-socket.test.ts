import { randomUUID } from 'node:crypto';

import {
  chatJoinAckSchema,
  chatSendRequestSchema,
  disputeRoom,
  sanitizeChatMessage,
  sanitizeChatUser,
  stripChatPii,
} from './chat-socket';

/** A full users row, as the server loads it from PostgreSQL. */
const AARAV_ROW = {
  id: randomUUID(),
  phone: '+9779800000001',
  phone_number: '+9779800000001',
  role: 'CUSTOMER',
  first_name: 'Aarav',
  last_name: 'Sharma',
  created_at: new Date('2026-09-01T00:00:00.000Z'),
};

function message(sender: unknown) {
  return {
    id: randomUUID(),
    client_id: 'client-1',
    order_id: randomUUID(),
    sender,
    body: 'The honey jar arrived broken.',
    attachments: [
      {
        url: 'http://localhost:4000/uploads/dispute-evidence/a.webp',
        content_type: 'image/webp',
        phone_number: '+9779800000001',
      },
    ],
    sent_at: '2026-09-30T10:00:00.000Z',
    // A careless caller could even attach PII next to the sender.
    last_name: 'Sharma',
    meta: { nested: { phone: '+9779800000001', last_name: 'Sharma', keep: 1 } },
  };
}

function expectNoPii(value: unknown): void {
  const json = JSON.stringify(value);
  for (const needle of ['last_name', 'phone_number', '"phone"', 'Sharma', '+9779800000001']) {
    expect(json).not.toContain(needle);
  }
}

describe('/chat privacy filter (SPEC implicit requirement 6)', () => {
  it('stripChatPii removes last_name, phone_number and phone at every depth', () => {
    const stripped = stripChatPii(message(AARAV_ROW));

    expectNoPii(stripped);
    expect(stripped).toMatchObject({ meta: { nested: { keep: 1 } } });
  });

  it('stripChatPii never mutates its input', () => {
    const input = message(AARAV_ROW);
    stripChatPii(input);

    expect(input.sender).toBe(AARAV_ROW);
    expect(AARAV_ROW.last_name).toBe('Sharma');
    expect(input.last_name).toBe('Sharma');
  });

  it('sanitizeChatUser reduces a users row to id, first name and role', () => {
    expect(sanitizeChatUser(AARAV_ROW)).toEqual({
      id: AARAV_ROW.id,
      first_name: 'Aarav',
      role: 'CUSTOMER',
    });
  });

  it('sanitizeChatMessage keeps only the allowlisted message shape', () => {
    const input = message(AARAV_ROW);
    const sanitized = sanitizeChatMessage(input);

    expect(sanitized).toEqual({
      id: input.id,
      client_id: 'client-1',
      order_id: input.order_id,
      sender: { id: AARAV_ROW.id, first_name: 'Aarav', role: 'CUSTOMER' },
      body: 'The honey jar arrived broken.',
      attachments: [
        {
          url: 'http://localhost:4000/uploads/dispute-evidence/a.webp',
          content_type: 'image/webp',
        },
      ],
      sent_at: '2026-09-30T10:00:00.000Z',
    });
    expectNoPii(sanitized);
  });

  it('sanitizeChatMessage refuses a payload without a valid sender', () => {
    expect(sanitizeChatMessage(message(null))).toBeNull();
    expect(sanitizeChatMessage(message({ id: 'x', role: 'ROOT' }))).toBeNull();
  });

  it('a sender without a first name keeps null (never a surname instead)', () => {
    expect(sanitizeChatUser({ ...AARAV_ROW, first_name: null })).toEqual({
      id: AARAV_ROW.id,
      first_name: null,
      role: 'CUSTOMER',
    });
  });
});

describe('/chat requests', () => {
  const orderId = randomUUID();

  it('reads only client_id, order_id, body and attachments from a sent message', () => {
    const parsed = chatSendRequestSchema.parse({
      client_id: 'c-1',
      order_id: orderId,
      body: '  Please refund.  ',
      sender: { id: 'someone-else', role: 'SUPER_ADMIN', last_name: 'X' },
      id: 'spoofed',
      sent_at: '2020-01-01T00:00:00.000Z',
    });

    expect(parsed).toEqual({
      client_id: 'c-1',
      order_id: orderId,
      body: 'Please refund.',
      attachments: [],
    });
  });

  it('refuses a message with neither text nor an image', () => {
    expect(
      chatSendRequestSchema.safeParse({ client_id: 'c-1', order_id: orderId, body: '   ' }).success,
    ).toBe(false);
  });

  it('refuses attachments that are not http(s) image URLs', () => {
    const base = { client_id: 'c-1', order_id: orderId, body: '' };
    expect(
      chatSendRequestSchema.safeParse({
        ...base,
        attachments: [{ url: 'javascript:alert(1)', content_type: 'image/png' }],
      }).success,
    ).toBe(false);
    expect(
      chatSendRequestSchema.safeParse({
        ...base,
        attachments: [{ url: 'https://cdn.test/a.pdf', content_type: 'application/pdf' }],
      }).success,
    ).toBe(false);
  });

  it('names rooms per order and validates join acks', () => {
    expect(disputeRoom(orderId)).toBe(`dispute:${orderId}`);
    expect(chatJoinAckSchema.parse({ ok: true, order_id: orderId })).toEqual({
      ok: true,
      order_id: orderId,
    });
    expect(
      chatJoinAckSchema.safeParse({ ok: false, error: { code: 'NOPE', message: '' } }).success,
    ).toBe(false);
  });
});
