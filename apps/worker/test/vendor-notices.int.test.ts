import { randomInt, randomUUID } from 'node:crypto';

import {
  createDatabase,
  enqueueDomainEvent,
  outboxEvents,
  outboxRowToDomainEvent,
  users,
  vendors,
  type Database,
} from '@hamro-pasal/db';
import type { KafkaJS } from '@hamro-pasal/kafka';
import type { VendorStatus } from '@hamro-pasal/shared-types';
import { and, eq } from 'drizzle-orm';
import { Redis } from 'ioredis';

import { ComplianceSweepService } from '../src/compliance/compliance-sweep';
import { RedisEventDeduplicator } from '../src/consumers/order-state-fanout';
import { VENDOR_NOTICE_DEDUPE_PREFIX, vendorNoticeConsumer } from '../src/consumers/vendor-notices';
import { LoggerNotificationAdapter } from '../src/notifications/notification-adapter';
import { DatabaseVendorContacts } from '../src/notifications/vendor-notices';

/**
 * Phase 36 on real PostgreSQL and Redis: an event as the outbox stores it, in the bytes the
 * relay publishes, handled by the vendor notice consumer with the logger adapter. Kafka itself is
 * not in the path (the relay and the consumer loop have their own suites).
 */
describe('vendor notices (outbox row → consumer → logger, real PostgreSQL + Redis)', () => {
  let db: Database;
  let redis: Redis;
  let lines: string[];
  let handle: (payload: KafkaJS.EachMessagePayload) => Promise<void>;

  beforeAll(() => {
    db = createDatabase(process.env.TEST_DATABASE_URL ?? '', { max: 5 });
    redis = new Redis(process.env.TEST_REDIS_URL ?? '');
  });

  beforeEach(() => {
    lines = [];
    handle = vendorNoticeConsumer({
      notifications: new LoggerNotificationAdapter((line) => lines.push(line)),
      contacts: new DatabaseVendorContacts(db),
      deduplicator: new RedisEventDeduplicator(redis, VENDOR_NOTICE_DEDUPE_PREFIX),
      onSent: () => undefined,
    }).handle;
  });

  afterAll(async () => {
    await redis.quit();
    await db.$client.end();
  });

  const freshPhone = () => `+9779${String(randomInt(0, 1_000_000_000)).padStart(9, '0')}`;

  async function vendor(status: VendorStatus = 'LIVE'): Promise<{ id: string; phone: string }> {
    const phone = freshPhone();
    const [user] = await db
      .insert(users)
      .values({ phone: freshPhone(), role: 'VENDOR' })
      .returning({ id: users.id });
    if (user === undefined) throw new Error('user not created');
    const [row] = await db
      .insert(vendors)
      .values({
        user_id: user.id,
        business_name: `Notice Pasal ${randomUUID()}`,
        phone,
        status,
        pricing_model: 'COMMISSION',
        commission_rate: 0.1,
        delivery_scope: 'RADIUS_BOUND',
        fulfillment_mode: 'SELF_DELIVERY',
        radius_km: 5,
        municipality_palika_string: 'Kathmandu Metropolitan City',
        min_order_value: 0,
        location: { x: 85.3123, y: 27.7154 },
      })
      .returning({ id: vendors.id });
    if (row === undefined) throw new Error('vendor not created');
    return { id: row.id, phone };
  }

  /** The Kafka message the relay would publish for a stored outbox row. */
  async function messageOf(aggregateId: string, type: string): Promise<KafkaJS.EachMessagePayload> {
    const [row] = await db
      .select()
      .from(outboxEvents)
      .where(and(eq(outboxEvents.aggregate_id, aggregateId), eq(outboxEvents.event_type, type)));
    if (row === undefined) throw new Error(`no ${type} event in the outbox`);
    return {
      topic: row.topic,
      partition: 0,
      message: { value: Buffer.from(JSON.stringify(outboxRowToDomainEvent(row))), offset: '0' },
    } as unknown as KafkaJS.EachMessagePayload;
  }

  it('turns the compliance sweep’s outbox event into one SMS line and one push line', async () => {
    const shop = await vendor();
    await new ComplianceSweepService(db).suspendVendorsWithoutPan();
    const message = await messageOf(shop.id, 'vendor.suspended_for_compliance');
    expect(message.topic).toBe('notifications.broadcast');

    await handle(message);
    // Kafka delivers at least once: the same event again changes nothing.
    await handle(message);
    await handle(message);

    expect(lines).toEqual([
      `[notify:sms] to ${shop.phone}: Hamro Pasal: your shop is offline because no PAN is on file. Please add your 9-digit PAN in the app (Shop settings) and your shop goes back online at once.`,
      `[notify:push] to vendor ${shop.id}: Your shop is offline | Please add your PAN in Shop settings. Your shop goes back online as soon as it is saved.`,
    ]);
  });

  it('holds its claims in Redis: a second worker handling the same event stays silent', async () => {
    const shop = await vendor();
    await new ComplianceSweepService(db).suspendVendorsWithoutPan();
    const message = await messageOf(shop.id, 'vendor.suspended_for_compliance');
    const other: string[] = [];
    const second = vendorNoticeConsumer({
      notifications: new LoggerNotificationAdapter((line) => other.push(line)),
      contacts: new DatabaseVendorContacts(db),
      deduplicator: new RedisEventDeduplicator(redis, VENDOR_NOTICE_DEDUPE_PREFIX),
      onSent: () => undefined,
    }).handle;

    await Promise.all([handle(message), second(message), handle(message), second(message)]);

    expect([...lines, ...other]).toHaveLength(2);
  });

  it('tells each shop of a changed campaign at its own number, and not a deactivated one', async () => {
    const first = await vendor();
    const second = await vendor('SUSPENDED');
    const closed = await vendor('DEACTIVATED');
    const campaignId = randomUUID();
    await db.transaction((tx) =>
      enqueueDomainEvent(tx, {
        type: 'marketing.campaign_terms_changed',
        aggregateId: campaignId,
        payload: {
          campaign_id: campaignId,
          campaign_name: 'Tihar Offer',
          previous_terms_version: 3,
          terms_version: 4,
          voided_vendor_ids: [first.id, second.id, closed.id, randomUUID()],
          voided_opt_in_count: 4,
          changed_by_user_id: randomUUID(),
          changed_at: new Date().toISOString(),
        },
      }),
    );
    const message = await messageOf(campaignId, 'marketing.campaign_terms_changed');

    await handle(message);
    await handle(message);

    const sms = lines.filter((line) => line.startsWith('[notify:sms]'));
    expect(sms).toEqual(
      [first, second].map(
        (shop) =>
          `[notify:sms] to ${shop.phone}: Hamro Pasal: the terms of the campaign "Tihar Offer" have changed, so your shop is no longer in it. Please review the new terms under Marketing in the app to opt in again.`,
      ),
    );
    expect(lines.join('\n')).not.toContain(closed.phone);
    expect(lines).toHaveLength(4);
  });

  it('retries the shop a provider refused without telling the others again', async () => {
    const first = await vendor();
    const second = await vendor();
    const campaignId = randomUUID();
    await db.transaction((tx) =>
      enqueueDomainEvent(tx, {
        type: 'marketing.campaign_terms_changed',
        aggregateId: campaignId,
        payload: {
          campaign_id: campaignId,
          campaign_name: 'Dashain 10%',
          previous_terms_version: 1,
          terms_version: 2,
          voided_vendor_ids: [first.id, second.id],
          voided_opt_in_count: 2,
          changed_by_user_id: randomUUID(),
          changed_at: new Date().toISOString(),
        },
      }),
    );
    const message = await messageOf(campaignId, 'marketing.campaign_terms_changed');
    const told: string[] = [];
    let refuse = true;
    const flaky = vendorNoticeConsumer({
      notifications: {
        name: 'FLAKY',
        send: (notice) => {
          if (refuse && notice.vendorId === first.id) return Promise.reject(new Error('503'));
          told.push(notice.vendorId);
          return Promise.resolve();
        },
      },
      contacts: new DatabaseVendorContacts(db),
      deduplicator: new RedisEventDeduplicator(redis, VENDOR_NOTICE_DEDUPE_PREFIX),
      onSent: () => undefined,
    }).handle;

    await expect(flaky(message)).rejects.toThrow('503');
    expect(told).toEqual([second.id]);

    refuse = false;
    await flaky(message);

    expect(told).toEqual([second.id, first.id]);
  });
});
