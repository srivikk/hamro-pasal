import { randomInt, randomUUID } from 'node:crypto';

import {
  createDatabase,
  deviceTokens,
  notificationMessages,
  recordNotificationMessage,
  users,
  type Database,
} from '@hamro-pasal/db';
import { eq, inArray } from 'drizzle-orm';

import { AdminPushService } from '../src/notifications/admin-push';
import type { ExpoPushMessage, PushGateway, PushTicket } from '../src/push/expo-push';

class RecordingPush implements PushGateway {
  readonly requests: ExpoPushMessage[][] = [];
  unregistered = new Set<string>();
  failRequest = -1;

  send(messages: readonly ExpoPushMessage[]): Promise<PushTicket[]> {
    this.requests.push([...messages]);
    if (this.requests.length - 1 === this.failRequest) {
      return Promise.reject(new Error('Expo is down'));
    }
    return Promise.resolve(
      messages.map((m) =>
        this.unregistered.has(m.to)
          ? { token: m.to, status: 'error' as const, error: 'DeviceNotRegistered', message: 'gone' }
          : { token: m.to, status: 'ok' as const, id: randomUUID() },
      ),
    );
  }

  get tokens(): string[] {
    return this.requests.flat().map((m) => m.to);
  }
}

/** Step 7.5 (SPEC core 11, verification 31): pushing the Super Admin's messages. */
describe('admin push (real PostgreSQL)', () => {
  let db: Database;
  let adminId: string;

  beforeAll(async () => {
    db = createDatabase(process.env.TEST_DATABASE_URL ?? '', { max: 10 });
    adminId = await user('SUPER_ADMIN');
  });

  afterAll(async () => {
    await db.$client.end();
  });

  async function user(role: 'CUSTOMER' | 'VENDOR' | 'SUPER_ADMIN', devices = 0) {
    const phone = `+9779${String(randomInt(0, 1_000_000_000)).padStart(9, '0')}`;
    const [row] = await db.insert(users).values({ phone, role }).returning({ id: users.id });
    if (row === undefined) throw new Error('user not created');
    for (let i = 0; i < devices; i += 1) {
      await db.insert(deviceTokens).values({
        user_id: row.id,
        token: `ExponentPushToken[${randomUUID()}]`,
        platform: 'ANDROID',
      });
    }
    return row.id;
  }

  const tokensOf = async (userIds: string[]) =>
    (
      await db
        .select({ token: deviceTokens.token })
        .from(deviceTokens)
        .where(inArray(deviceTokens.user_id, userIds))
    ).map((row) => row.token);

  async function message(audience: 'VENDOR' | 'ALL_CUSTOMERS', recipients: string[] = []) {
    const stored = await recordNotificationMessage(db, {
      audience,
      source: 'ADMIN',
      title: 'Hello',
      body: 'A message from Hamro Pasal.',
      data: { deep_link: '/orders' },
      createdByUserId: adminId,
      recipientUserIds: recipients,
    });
    return stored.id;
  }

  const row = async (id: string) =>
    (await db.select().from(notificationMessages).where(eq(notificationMessages.id, id)))[0];

  it('pushes a vendor message to the chosen shops devices only, once, and records the counts', async () => {
    const chosen = [await user('VENDOR', 2), await user('VENDOR', 1)];
    const bystander = await user('VENDOR', 1);
    const id = await message('VENDOR', chosen);
    const push = new RecordingPush();

    await expect(new AdminPushService(db, push).deliver(id)).resolves.toEqual({
      status: 'PUSHED',
      sent: 3,
      failed: 0,
    });
    expect(push.tokens.sort()).toEqual((await tokensOf(chosen)).sort());
    expect(push.tokens).not.toContain((await tokensOf([bystander]))[0]);
    expect(push.requests[0]?.[0]).toMatchObject({
      title: 'Hello',
      data: { type: 'admin.message', message_id: id, deep_link: '/orders' },
    });
    expect(await row(id)).toMatchObject({ push_sent_count: 3, push_failed_count: 0 });
    expect((await row(id))?.push_completed_at).toBeInstanceOf(Date);

    // A redelivered event pushes nothing again.
    await expect(new AdminPushService(db, push).deliver(id)).resolves.toEqual({
      status: 'SKIPPED',
    });
    expect(push.requests).toHaveLength(1);
  });

  it('broadcasts to customers registered before the message, 100 devices per request', async () => {
    const customers: string[] = [];
    for (let i = 0; i < 3; i += 1) customers.push(await user('CUSTOMER', 1));
    const vendor = await user('VENDOR', 1);
    const id = await message('ALL_CUSTOMERS');
    const later = await user('CUSTOMER', 1);
    const push = new RecordingPush();

    await new AdminPushService(db, push, 2).deliver(id);

    const pushed = new Set(push.tokens);
    for (const token of await tokensOf(customers)) expect(pushed.has(token)).toBe(true);
    expect(pushed.has((await tokensOf([vendor]))[0] ?? '')).toBe(false);
    expect(pushed.has((await tokensOf([later]))[0] ?? '')).toBe(false);
    for (const request of push.requests) expect(request.length).toBeLessThanOrEqual(2);
  });

  it('forgets unregistered devices and counts a failed request, still sending the rest', async () => {
    const shops = [await user('VENDOR', 2), await user('VENDOR', 2)];
    const id = await message('VENDOR', shops);
    const push = new RecordingPush();
    // The first request fails as a whole; every device in the second is no longer registered.
    push.failRequest = 0;
    for (const token of await tokensOf(shops)) push.unregistered.add(token);

    const outcome = await new AdminPushService(db, push, 2).deliver(id);

    expect(push.requests).toHaveLength(2);
    expect(outcome).toEqual({ status: 'PUSHED', sent: 0, failed: 4 });
    // The two refused as unregistered are forgotten; the two of the failed request are kept.
    const kept = await tokensOf(shops);
    expect(kept.sort()).toEqual((push.requests[0] ?? []).map((m) => m.to).sort());
    expect(await row(id)).toMatchObject({ push_sent_count: 0, push_failed_count: 4 });
  });

  it('records zero for a message nobody has a device for, and ignores system messages', async () => {
    const shop = await user('VENDOR', 0);
    const id = await message('VENDOR', [shop]);
    const push = new RecordingPush();

    await expect(new AdminPushService(db, push).deliver(id)).resolves.toEqual({
      status: 'PUSHED',
      sent: 0,
      failed: 0,
    });
    expect(push.requests).toEqual([]);

    const system = await recordNotificationMessage(db, {
      audience: 'VENDOR',
      source: 'SYSTEM',
      title: 'Notice',
      body: 'From the system.',
      recipientUserIds: [shop],
    });
    await expect(new AdminPushService(db, push).deliver(system.id)).resolves.toEqual({
      status: 'SKIPPED',
    });
  });
});
