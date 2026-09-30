import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  chatJoinAckSchema,
  chatMessageSchema,
  chatSendAckSchema,
  type ChatJoinAck,
  type ChatMessage,
  type ChatSendAck,
  type Dispute,
  type User,
  type UserRole,
} from '@hamro-pasal/shared-types';
import { io as connectClient, type Socket as ClientSocket } from 'socket.io-client';

import { signAccessToken } from '../auth/access-token';
import type { DisputeAccess, DisputeParticipant } from '../disputes/dispute-service';
import { attachRealtime, type RealtimeServer } from './orders-namespace';

/*
 * The /chat namespace over real Socket.io connections (in process, no Redis): above all, that the
 * server's privacy filter strips last_name and phone_number from every user object it broadcasts
 * (SPEC implicit requirement 6), whatever the database row or the client sent.
 */

const SECRET = 'unit-test-access-secret-0123456789abcdef';
const ORDER_ID = randomUUID();
const OTHER_ORDER_ID = randomUUID();
const EVIDENCE_BASE = `http://localhost:4000/uploads/dispute-evidence/${ORDER_ID}/`;
const EVIDENCE_URL = `${EVIDENCE_BASE}${randomUUID()}.webp`;

function userRow(role: UserRole, firstName: string | null, lastName: string, phone: string): User {
  return {
    id: randomUUID(),
    phone,
    role,
    first_name: firstName,
    last_name: lastName,
    created_at: new Date('2026-09-01T00:00:00.000Z'),
    updated_at: new Date('2026-09-01T00:00:00.000Z'),
  };
}

const AARAV = userRow('CUSTOMER', 'Aarav', 'Sharma', '+9779800000001');
const RAM = userRow('VENDOR', 'Ram', 'Shrestha', '+9779800000011');
const ADMIN = userRow('SUPER_ADMIN', null, 'Adhikari', '+9779800000099');
const OUTSIDER = userRow('CUSTOMER', 'Sita', 'Karki', '+9779800000002');
const DISPUTE: Dispute = {
  id: randomUUID(),
  order_id: ORDER_ID,
  opened_by_user_id: AARAV.id,
  reason: 'Broken jar',
  status: 'OPEN',
  resolved_by_user_id: null,
  resolved_at: null,
  created_at: new Date('2026-09-30T08:00:00.000Z'),
  updated_at: new Date('2026-09-30T08:00:00.000Z'),
};
const USERS = new Map([AARAV, RAM, ADMIN, OUTSIDER].map((user) => [user.id, user]));

const PII = ['last_name', 'phone_number', '"phone"', 'Sharma', 'Shrestha', 'Adhikari', '+97798'];

function expectNoPii(value: unknown): void {
  const json = JSON.stringify(value);
  for (const needle of PII) expect(json).not.toContain(needle);
}

/** Aarav and Ram are the parties of ORDER_ID; OTHER_ORDER_ID's window has closed. */
function fakeAccess(participant: DisputeParticipant, orderId: string): Promise<DisputeAccess> {
  if (participant.role === 'SUPER_ADMIN') return Promise.resolve({ ok: true });
  const party = participant.userId === AARAV.id || participant.userId === RAM.id;
  if (!party) return Promise.resolve({ ok: false, code: 'ORDER_NOT_FOUND' });
  return Promise.resolve(
    orderId === ORDER_ID ? { ok: true } : { ok: false, code: 'DISPUTE_WINDOW_CLOSED' },
  );
}

describe('/chat namespace', () => {
  let realtime: RealtimeServer;
  let url: string;
  const clients: ClientSocket[] = [];
  const sentAt = new Date('2026-09-30T08:15:00.000Z');

  beforeAll(async () => {
    const httpServer = createServer();
    realtime = attachRealtime(httpServer, {
      accessTokenSecret: SECRET,
      orders: { isCustomerOrder: () => Promise.resolve(false) },
      vendors: { vendorIdForUser: () => Promise.resolve(null) },
      chat: {
        disputes: {
          access: fakeAccess,
          participantProfile: (userId) => Promise.resolve(USERS.get(userId) ?? null),
          // In-memory stand-in for the transcript (persistence is covered by the integration test).
          recordMessage: (input) =>
            Promise.resolve({
              message: {
                id: randomUUID(),
                dispute_id: DISPUTE.id,
                sender_user_id: input.senderUserId,
                client_id: input.clientId,
                body: input.body,
                attachments: [...input.attachments],
                created_at: sentAt,
              },
              dispute: DISPUTE,
              disputeOpened: false,
              replayed: false,
            }),
        },
        evidence: {
          isEvidenceUrl: (orderId, candidate) =>
            candidate.startsWith(`http://localhost:4000/uploads/dispute-evidence/${orderId}/`),
        },
      },
    });
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${String((httpServer.address() as AddressInfo).port)}`;
  });

  afterEach(() => {
    for (const client of clients.splice(0)) client.disconnect();
  });

  afterAll(async () => {
    await realtime.close();
  });

  function client(auth: Record<string, unknown>): ClientSocket {
    const socket = connectClient(`${url}/chat`, {
      transports: ['websocket'],
      auth,
      reconnection: false,
      forceNew: true,
    });
    clients.push(socket);
    return socket;
  }

  /** A connected participant and every raw payload the server pushed to it. */
  async function participant(user: User) {
    const socket = client({ token: signAccessToken({ userId: user.id, role: user.role }, SECRET) });
    const received: unknown[] = [];
    socket.on('chat:new_message', (payload: unknown) => {
      received.push(payload);
    });
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('connect_error', reject);
    });
    return { socket, received };
  }

  async function join(socket: ClientSocket, orderId: unknown): Promise<ChatJoinAck> {
    const ack: unknown = await socket
      .timeout(5_000)
      .emitWithAck('chat:join', { order_id: orderId });
    return chatJoinAckSchema.parse(ack);
  }

  async function send(socket: ClientSocket, payload: unknown): Promise<ChatSendAck> {
    const ack: unknown = await socket.timeout(5_000).emitWithAck('chat:new_message', payload);
    return chatSendAckSchema.parse(ack);
  }

  async function until(condition: () => boolean, timeoutMs = 3_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!condition()) {
      if (Date.now() > deadline) throw new Error('Timed out waiting for condition');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  async function joinedPair() {
    const customer = await participant(AARAV);
    const vendor = await participant(RAM);
    expect(await join(customer.socket, ORDER_ID)).toEqual({ ok: true, order_id: ORDER_ID });
    expect(await join(vendor.socket, ORDER_ID)).toEqual({ ok: true, order_id: ORDER_ID });
    return { customer, vendor };
  }

  describe('privacy filter (SPEC implicit requirement 6)', () => {
    it("strips the customer's last_name and phone before the vendor receives the message", async () => {
      const { customer, vendor } = await joinedPair();

      const ack = await send(customer.socket, {
        client_id: 'c-1',
        order_id: ORDER_ID,
        body: 'The honey jar arrived broken.',
      });
      await until(() => vendor.received.length === 1);

      const [raw] = vendor.received;
      expectNoPii(raw);
      expect(Object.keys((raw as { sender: object }).sender).sort()).toEqual([
        'first_name',
        'id',
        'role',
      ]);
      expect(chatMessageSchema.parse(raw)).toEqual({
        id: expect.any(String) as string,
        client_id: 'c-1',
        order_id: ORDER_ID,
        sender: { id: AARAV.id, first_name: 'Aarav', role: 'CUSTOMER' },
        body: 'The honey jar arrived broken.',
        attachments: [],
        sent_at: sentAt.toISOString(),
      });
      // The sender's ack carries exactly what was broadcast, and is filtered too.
      expect(ack.ok && ack.message).toEqual(raw);
      expectNoPii(ack);
    });

    it("strips the vendor's surname and phone before the customer receives the reply", async () => {
      const { customer, vendor } = await joinedPair();

      await send(vendor.socket, { client_id: 'v-1', order_id: ORDER_ID, body: 'Sorry! A photo?' });
      await until(() => customer.received.length === 1);

      expectNoPii(customer.received);
      expect((customer.received[0] as ChatMessage).sender).toEqual({
        id: RAM.id,
        first_name: 'Ram',
        role: 'VENDOR',
      });
    });

    it('ignores a sender (or any PII) the client puts in its payload', async () => {
      const { customer, vendor } = await joinedPair();

      await send(customer.socket, {
        id: 'spoofed-id',
        client_id: 'c-2',
        order_id: ORDER_ID,
        body: 'Refund please',
        sent_at: '2020-01-01T00:00:00.000Z',
        sender: {
          id: ADMIN.id,
          first_name: 'Support',
          last_name: 'Sharma',
          phone_number: '+9779800000001',
          role: 'SUPER_ADMIN',
        },
        last_name: 'Sharma',
        phone_number: '+9779800000001',
      });
      await until(() => vendor.received.length === 1);

      const message = vendor.received[0] as ChatMessage;
      expectNoPii(vendor.received);
      expect(message.id).not.toBe('spoofed-id');
      expect(message.sent_at).toBe(sentAt.toISOString());
      expect(message.sender).toEqual({ id: AARAV.id, first_name: 'Aarav', role: 'CUSTOMER' });
    });

    it('labels an admin without a first name by role only, never by surname', async () => {
      const { customer } = await joinedPair();
      const admin = await participant(ADMIN);
      await join(admin.socket, ORDER_ID);

      await send(admin.socket, { client_id: 'a-1', order_id: ORDER_ID, body: 'Looking into it.' });
      await until(() => customer.received.length === 1);

      expectNoPii(customer.received);
      expect((customer.received[0] as ChatMessage).sender).toEqual({
        id: ADMIN.id,
        first_name: null,
        role: 'SUPER_ADMIN',
      });
    });
  });

  describe('handshake', () => {
    function refusal(auth: Record<string, unknown>) {
      const socket = client(auth);
      return new Promise<{ message: string; code: unknown }>((resolve, reject) => {
        socket.once('connect', () => {
          reject(new Error('connection was accepted'));
        });
        socket.once('connect_error', (error: Error & { data?: { code?: unknown } }) => {
          resolve({ message: error.message, code: error.data?.code });
        });
      });
    }

    it.each([
      ['no token', {}],
      ['a malformed token', { token: 'not-a-jwt' }],
      [
        'a token for another secret',
        { token: signAccessToken({ userId: AARAV.id, role: 'CUSTOMER' }, 'y'.repeat(40)) },
      ],
    ])('refuses %s with UNAUTHENTICATED (the mobile client then renews)', async (_label, auth) => {
      await expect(refusal(auth)).resolves.toEqual({
        message: 'UNAUTHENTICATED',
        code: 'UNAUTHENTICATED',
      });
    });

    it('refuses drivers with FORBIDDEN', async () => {
      await expect(
        refusal({ token: signAccessToken({ userId: randomUUID(), role: 'DRIVER' }, SECRET) }),
      ).resolves.toEqual({ message: 'FORBIDDEN', code: 'FORBIDDEN' });
    });
  });

  describe('rooms and access', () => {
    it('refuses someone who is not a party to the order, without revealing it exists', async () => {
      const outsider = await participant(OUTSIDER);

      expect(await join(outsider.socket, ORDER_ID)).toEqual({
        ok: false,
        error: { code: 'ORDER_NOT_FOUND', message: 'Order not found' },
      });
      expect(
        await send(outsider.socket, { client_id: 'x', order_id: ORDER_ID, body: 'hi' }),
      ).toMatchObject({ ok: false, error: { code: 'ORDER_NOT_FOUND' } });
    });

    it('refuses an order whose 48 h window has closed', async () => {
      const customer = await participant(AARAV);

      expect(await join(customer.socket, OTHER_ORDER_ID)).toMatchObject({
        ok: false,
        error: { code: 'DISPUTE_WINDOW_CLOSED' },
      });
    });

    it('validates join and message payloads', async () => {
      const customer = await participant(AARAV);

      expect(await join(customer.socket, 'not-a-uuid')).toMatchObject({
        ok: false,
        error: { code: 'VALIDATION_FAILED' },
      });
      expect(
        await send(customer.socket, { client_id: 'c', order_id: ORDER_ID, body: '   ' }),
      ).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } });
      expect(
        await send(customer.socket, { client_id: 'c', order_id: ORDER_ID, body: 'x'.repeat(2001) }),
      ).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } });
    });

    it('accepts evidence uploaded for the order and refuses foreign image URLs', async () => {
      const { customer, vendor } = await joinedPair();
      const image = { url: EVIDENCE_URL, content_type: 'image/webp' };

      const ok = await send(customer.socket, {
        client_id: 'c-img',
        order_id: ORDER_ID,
        body: '',
        attachments: [image],
      });
      const foreign = await send(customer.socket, {
        client_id: 'c-bad',
        order_id: ORDER_ID,
        body: '',
        attachments: [{ url: 'https://tracker.example/pixel.png', content_type: 'image/png' }],
      });
      await until(() => vendor.received.length === 1);

      expect(ok).toMatchObject({ ok: true, message: { attachments: [image] } });
      expect(foreign).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } });
      expect(vendor.received).toHaveLength(1);
    });

    it("delivers only to the order's room", async () => {
      const { customer } = await joinedPair();
      const admin = await participant(ADMIN);
      await join(admin.socket, OTHER_ORDER_ID); // another dispute

      await send(customer.socket, { client_id: 'c-3', order_id: ORDER_ID, body: 'Hello' });
      await until(() => customer.received.length === 1); // the sender's own echo
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(admin.received).toEqual([]);
    });
  });
});
