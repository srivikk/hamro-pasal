import { randomUUID } from 'node:crypto';

import type { KafkaJS } from '@hamro-pasal/kafka';
import type { DomainEvent } from '@hamro-pasal/shared-types';

import {
  LoggerNotificationAdapter,
  noticeLogLines,
  type NotificationAdapter,
  type VendorNotice,
} from '../notifications/notification-adapter';
import {
  isVendorNoticeEvent,
  MAX_QUOTED_CAMPAIGN_NAME,
  nepalDate,
  vendorNoticesOf,
  type VendorContactReader,
  type VendorNoticeEvent,
} from '../notifications/vendor-notices';
import { SINGLE_SMS_SEGMENT_LENGTH } from '../notifications/vendor-sms';
import { buildConsumers, routeByTopic } from './index';
import { RedisEventDeduplicator, type EventDeduplicator } from './order-state-fanout';
import { VENDOR_NOTICE_DEDUPE_PREFIX, vendorNoticeConsumer } from './vendor-notices';

const AT = '2026-10-09T06:15:00.000Z';
const PHONE = '+9779800000011';

function envelope<T extends VendorNoticeEvent['event_type']>(
  type: T,
  aggregateId: string,
  payload: Extract<VendorNoticeEvent, { event_type: T }>['payload'],
): Extract<VendorNoticeEvent, { event_type: T }> {
  return {
    event_id: randomUUID(),
    event_type: type,
    event_version: 1,
    occurred_at: AT,
    aggregate_id: aggregateId,
    payload,
  } as Extract<VendorNoticeEvent, { event_type: T }>;
}

function suspended(vendorId: string = randomUUID()) {
  return envelope('vendor.suspended_for_compliance', vendorId, {
    vendor_id: vendorId,
    vendor_phone: PHONE,
    previous_status: 'LIVE',
    suspended_at: AT,
  });
}

function restored(status: 'LIVE' | 'SUSPENDED' | 'APPROVED' = 'LIVE', vendorId = randomUUID()) {
  return envelope('vendor.compliance_restored', vendorId, {
    vendor_id: vendorId,
    vendor_phone: PHONE,
    status,
    waiting_invoices_issued: 0,
    restored_at: AT,
  });
}

function deactivated(walletBalanceNpr = 0, vendorId = randomUUID()) {
  return envelope('vendor.deactivated', vendorId, {
    vendor_id: vendorId,
    vendor_phone: PHONE,
    wallet_balance_npr: walletBalanceNpr,
    cancelled_ad_count: 1,
    returned_npr: 0,
    deactivated_at: AT,
  });
}

function reactivated(status: 'LIVE' | 'SUSPENDED_COMPLIANCE' = 'LIVE', vendorId = randomUUID()) {
  return envelope('vendor.reactivated', vendorId, {
    vendor_id: vendorId,
    vendor_phone: PHONE,
    status,
    reactivated_by_user_id: randomUUID(),
    reactivated_at: AT,
  });
}

function adEnded(returnedNpr = 0, vendorId = randomUUID()) {
  const adId = randomUUID();
  return envelope('marketing.ad_ended', adId, {
    ad_purchase_id: adId,
    vendor_id: vendorId,
    vendor_phone: PHONE,
    billing_model: 'PER_ORDER_PREMIUM',
    // 18:30 UTC on the 8th is 00:15 on the 9th in Nepal.
    ends_at: '2026-10-08T18:30:00.000Z',
    returned_npr: returnedNpr,
    ended_at: AT,
  });
}

function adPaused(vendorId = randomUUID()) {
  const adId = randomUUID();
  return envelope('marketing.ad_paused', adId, {
    ad_purchase_id: adId,
    vendor_id: vendorId,
    vendor_phone: PHONE,
    reason: 'BUDGET_EXHAUSTED',
    budget_npr: 125_000,
    amount_paid_npr: 124_980.5,
    ends_at: AT,
    paused_at: AT,
  });
}

function termsChanged(vendorIds: string[], name = 'Dashain 10%') {
  const campaignId = randomUUID();
  return envelope('marketing.campaign_terms_changed', campaignId, {
    campaign_id: campaignId,
    campaign_name: name,
    previous_terms_version: 1,
    terms_version: 2,
    voided_vendor_ids: vendorIds,
    voided_opt_in_count: vendorIds.length,
    changed_by_user_id: randomUUID(),
    changed_at: AT,
  });
}

function kafkaMessage(event: unknown, raw?: string): KafkaJS.EachMessagePayload {
  return {
    topic: 'notifications.broadcast',
    partition: 0,
    message: { value: Buffer.from(raw ?? JSON.stringify(event)), offset: '7' },
  } as unknown as KafkaJS.EachMessagePayload;
}

/** Every shop is reachable at a number made from its place in the list. */
function contactsOf(phones: Record<string, string>): VendorContactReader & { asked: string[][] } {
  const asked: string[][] = [];
  return {
    asked,
    contacts: (ids) => {
      asked.push([...ids]);
      return Promise.resolve(
        ids.flatMap((id) =>
          phones[id] === undefined ? [] : [{ vendorId: id, phone: phones[id] }],
        ),
      );
    },
  };
}

class MemoryDeduplicator implements EventDeduplicator {
  readonly claims = new Set<string>();
  claim(id: string): Promise<boolean> {
    if (this.claims.has(id)) return Promise.resolve(false);
    this.claims.add(id);
    return Promise.resolve(true);
  }
  release(id: string): Promise<void> {
    this.claims.delete(id);
    return Promise.resolve();
  }
}

/** Records what it was given; refuses the shops in `failFor` while they are listed. */
class RecordingAdapter implements NotificationAdapter {
  readonly name = 'RECORDING';
  readonly sent: VendorNotice[] = [];
  readonly failFor = new Set<string>();
  send(notice: VendorNotice): Promise<void> {
    if (this.failFor.has(notice.vendorId)) {
      return Promise.reject(new Error(`provider refused ${notice.vendorId}`));
    }
    this.sent.push(notice);
    return Promise.resolve();
  }
}

const NO_CONTACTS = contactsOf({});

describe('vendor notice wording', () => {
  const wording = async (event: VendorNoticeEvent) => {
    const [notice] = await vendorNoticesOf(event, contactsOf({}));
    if (notice === undefined) throw new Error('no notice');
    return notice;
  };

  it('tells a shop suspended for compliance why it is offline and how to come back', async () => {
    // SPEC core 10 (amended 2026-10-20): only the verification brings it back.
    const event = suspended();
    expect(await wording(event)).toEqual({
      eventId: event.event_id,
      eventType: 'vendor.suspended_for_compliance',
      vendorId: event.payload.vendor_id,
      phone: PHONE,
      sms: 'Hamro Pasal: your shop is offline until Hamro Pasal verifies your PAN. Please add your PAN and upload your PAN certificate in the app (Shop settings).',
      push: {
        title: 'Your shop is offline',
        body: 'It goes back online once Hamro Pasal verifies your PAN. Please add your PAN and certificate in Shop settings.',
      },
    });
  });

  it('says the shop is back online only when it is', async () => {
    expect((await wording(restored('LIVE'))).sms).toBe(
      'Hamro Pasal: your PAN is verified and your shop is back online. Please open the app to take orders again.',
    );
    // A debt or admin suspension lies on top: the verification did not bring the shop back.
    const still = await wording(restored('SUSPENDED'));
    expect(still.sms).toContain('Your shop is still offline for another reason');
    expect(still.sms).not.toContain('back online');
    expect(still.push.title).toBe('PAN verified');
    const waiting = await wording(restored('APPROVED'));
    expect(waiting.sms).toContain('Your shop is not live yet');
    expect(waiting.sms).not.toContain('back online');
  });

  it('tells a vendor its shop account is closed, and what it is still owed', async () => {
    const owed = await wording(deactivated(1250.5));
    expect(owed.sms).toBe(
      'Hamro Pasal: your shop account is closed and signed out, as you asked. The Rs. 1,250.50 in your wallet will be paid to your bank account. Please contact Hamro Pasal support to reopen it.',
    );
    expect(owed.push.title).toBe('Your shop account is closed');

    const nothing = await wording(deactivated(0));
    expect(nothing.sms).toBe(
      'Hamro Pasal: your shop account is closed and signed out, as you asked. Please contact Hamro Pasal support to reopen it.',
    );
    expect(nothing.push.body).not.toContain('wallet');
  });

  it('says a reopened shop is online only when its PAN is verified', async () => {
    expect((await wording(reactivated('LIVE'))).sms).toBe(
      'Hamro Pasal: your shop has been reopened and is back online. Please sign in to the app to take orders. Your ads and campaigns must be set up again.',
    );
    const offline = await wording(reactivated('SUSPENDED_COMPLIANCE'));
    expect(offline.sms).toBe(
      'Hamro Pasal: your shop has been reopened, but it stays offline until Hamro Pasal verifies your PAN. Please sign in and check your PAN and certificate in Shop settings.',
    );
    expect(offline.sms).not.toContain('back online');
    expect(offline.push.body).toContain('stays offline');
  });

  it('gives the end of an ad as a Nepal Time date, with the budget that came back', async () => {
    expect(nepalDate('2026-10-08T18:30:00.000Z')).toBe('9 Oct 2026');
    expect(nepalDate('2026-10-08T18:14:59.000Z')).toBe('8 Oct 2026');
    expect(nepalDate('2026-12-31T18:15:00.000Z')).toBe('1 Jan 2027');

    expect((await wording(adEnded(225))).sms).toBe(
      'Hamro Pasal: your ad ended on 9 Oct 2026. Rs. 225 of unused budget is back in your wallet. Open Marketing in the app to book your next ad. Thank you.',
    );
    const nothingBack = await wording(adEnded(0));
    expect(nothingBack.sms).toBe(
      'Hamro Pasal: your ad ended on 9 Oct 2026. Open Marketing in the app to book your next ad. Thank you.',
    );
    expect(nothingBack.push.body).not.toContain('budget');
  });

  it('gives a paused ad its budget in rupees with the Nepali grouping', async () => {
    expect((await wording(adPaused())).sms).toBe(
      'Hamro Pasal: your per-order ad is paused. Its Rs. 1,25,000 budget cannot cover another order (Rs. 1,24,980.50 spent). Open Marketing in the app to book a new ad.',
    );
  });

  it('names the campaign whose terms changed, and shortens a very long name', async () => {
    const vendorId = randomUUID();
    const [notice] = await vendorNoticesOf(
      termsChanged([vendorId]),
      contactsOf({ [vendorId]: PHONE }),
    );
    expect(notice?.sms).toBe(
      'Hamro Pasal: the terms of the campaign "Dashain 10%" have changed, so your shop is no longer in it. Please review the new terms under Marketing in the app to opt in again.',
    );

    const long = 'A'.repeat(90);
    const [shortened] = await vendorNoticesOf(
      termsChanged([vendorId], long),
      contactsOf({ [vendorId]: PHONE }),
    );
    expect(shortened?.sms).toContain(`"${'A'.repeat(MAX_QUOTED_CAMPAIGN_NAME - 3)}..."`);
    expect(shortened?.sms).not.toContain('A'.repeat(MAX_QUOTED_CAMPAIGN_NAME));
  });

  it('opens every text with the brand, in plain ASCII, with something to do next', async () => {
    const vendorId = randomUUID();
    const events = [
      suspended(),
      restored('LIVE'),
      restored('SUSPENDED'),
      restored('APPROVED'),
      deactivated(125_000),
      deactivated(0),
      reactivated('LIVE'),
      reactivated('SUSPENDED_COMPLIANCE'),
      adEnded(225),
      adEnded(0),
      adPaused(),
    ];
    const notices = [
      ...(await Promise.all(events.map(wording))),
      ...(await vendorNoticesOf(termsChanged([vendorId]), contactsOf({ [vendorId]: PHONE }))),
    ];
    expect(notices).toHaveLength(12);
    for (const notice of notices) {
      expect(notice.sms.startsWith('Hamro Pasal: ')).toBe(true);
      expect(notice.sms).toMatch(/^[\x20-\x7e]+$/);
      expect(notice.push.body).toMatch(/^[\x20-\x7e]+$/);
      expect(notice.sms).toMatch(/Please|Open Marketing/);
      // Two GSM-7 segments at most; the short ones fit one.
      expect(notice.sms.length).toBeLessThanOrEqual(2 * SINGLE_SMS_SEGMENT_LENGTH - 14);
      expect(notice.push.title.length).toBeLessThanOrEqual(40);
    }
  });

  it('words the seven notice events and no other', () => {
    expect(isVendorNoticeEvent(suspended())).toBe(true);
    expect(isVendorNoticeEvent(deactivated())).toBe(true);
    expect(isVendorNoticeEvent(reactivated())).toBe(true);
    expect(isVendorNoticeEvent(termsChanged([]))).toBe(true);
    const debt: DomainEvent = {
      event_id: randomUUID(),
      event_type: 'vendor.restored',
      event_version: 1,
      occurred_at: AT,
      aggregate_id: randomUUID(),
      payload: {
        vendor_id: randomUUID(),
        vendor_phone: PHONE,
        restored_status: 'LIVE',
        wallet_balance_npr: 0,
        transaction_id: randomUUID(),
        restored_at: AT,
      },
    };
    expect(isVendorNoticeEvent(debt)).toBe(false);
  });
});

describe('LoggerNotificationAdapter', () => {
  it('writes the SMS and the push to the log, and sends nothing', async () => {
    const lines: string[] = [];
    const fetchSpy = jest.spyOn(globalThis, 'fetch');
    const [notice] = await vendorNoticesOf(suspended(), NO_CONTACTS);
    if (notice === undefined) throw new Error('no notice');

    await new LoggerNotificationAdapter((line) => lines.push(line)).send(notice);

    expect(lines).toEqual([
      `[notify:sms] to ${PHONE}: ${notice.sms}`,
      `[notify:push] to vendor ${notice.vendorId}: Your shop is offline | ${notice.push.body}`,
    ]);
    expect(lines).toEqual(noticeLogLines(notice));
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('logs to standard output by default', async () => {
    const out = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const [notice] = await vendorNoticesOf(adPaused(), NO_CONTACTS);
    if (notice === undefined) throw new Error('no notice');

    await new LoggerNotificationAdapter().send(notice);

    expect(out.mock.calls.map(([line]) => String(line))).toEqual(noticeLogLines(notice));
    out.mockRestore();
  });
});

describe('vendorNoticeConsumer', () => {
  function harness(contacts: VendorContactReader = NO_CONTACTS) {
    const adapter = new RecordingAdapter();
    const deduplicator = new MemoryDeduplicator();
    const sent: string[] = [];
    const consumer = vendorNoticeConsumer({
      notifications: adapter,
      contacts,
      deduplicator,
      onSent: (notice, name) => sent.push(`${name}:${notice.vendorId}`),
    });
    return { adapter, deduplicator, sent, handle: consumer.handle, topic: consumer.topic };
  }

  it('listens on notifications.broadcast and hands each of the seven events to the adapter', async () => {
    const vendorId = randomUUID();
    const { adapter, handle, topic, sent } = harness(contactsOf({ [vendorId]: PHONE }));
    expect(topic).toBe('notifications.broadcast');
    const events = [
      suspended(),
      restored(),
      deactivated(700),
      reactivated(),
      adEnded(225),
      adPaused(),
      termsChanged([vendorId]),
    ];

    for (const event of events) await handle(kafkaMessage(event));

    expect(adapter.sent.map((notice) => notice.eventType)).toEqual([
      'vendor.suspended_for_compliance',
      'vendor.compliance_restored',
      'vendor.deactivated',
      'vendor.reactivated',
      'marketing.ad_ended',
      'marketing.ad_paused',
      'marketing.campaign_terms_changed',
    ]);
    expect(adapter.sent.map((notice) => notice.eventId)).toEqual(events.map((e) => e.event_id));
    expect(sent).toHaveLength(7);
  });

  it('tells a just-closed shop at the number in the event, without asking for its contact', async () => {
    // The contact reader leaves deactivated shops out; this notice must not depend on it.
    const contacts = contactsOf({});
    const { adapter, handle } = harness(contacts);
    const event = deactivated(700);

    await handle(kafkaMessage(event));

    expect(adapter.sent.map((notice) => [notice.vendorId, notice.phone])).toEqual([
      [event.payload.vendor_id, PHONE],
    ]);
    expect(contacts.asked).toEqual([]);
  });

  it('stops after three refusals in a row and leaves the rest of the shops for the retry', async () => {
    const ids = Array.from({ length: 8 }, () => randomUUID());
    const phones = Object.fromEntries(ids.map((id, i) => [id, `+97798000000${String(30 + i)}`]));
    const { adapter, deduplicator, handle } = harness(contactsOf(phones));
    const attempted: string[] = [];
    const send = adapter.send.bind(adapter);
    adapter.send = (notice) => {
      attempted.push(notice.vendorId);
      return send(notice);
    };
    const event = termsChanged(ids);
    // The provider is down from the second shop on.
    for (const id of ids.slice(1)) adapter.failFor.add(id);

    await expect(handle(kafkaMessage(event))).rejects.toBeInstanceOf(AggregateError);

    // One told, three timed out, four never tried (and never claimed).
    expect(attempted).toEqual(ids.slice(0, 4));
    expect([...deduplicator.claims]).toEqual([`${event.event_id}:${ids[0] ?? ''}`]);

    adapter.failFor.clear();
    await handle(kafkaMessage(event));

    expect(adapter.sent.map((notice) => notice.vendorId)).toEqual(ids);
  });

  it('does not count refusals that a delivered notice separates', async () => {
    const ids = Array.from({ length: 7 }, () => randomUUID());
    const phones = Object.fromEntries(ids.map((id, i) => [id, `+97798000000${String(40 + i)}`]));
    const { adapter, handle } = harness(contactsOf(phones));
    // Every other number is refused: bad numbers, not a provider outage.
    for (const id of ids.filter((_, i) => i % 2 === 1)) adapter.failFor.add(id);

    await expect(handle(kafkaMessage(termsChanged(ids)))).rejects.toBeInstanceOf(AggregateError);

    expect(adapter.sent.map((notice) => notice.vendorId)).toEqual(
      ids.filter((_, i) => i % 2 === 0),
    );
  });

  it('delivers a redelivered event (same event_id) once', async () => {
    const { adapter, handle } = harness();
    const event = suspended();

    await handle(kafkaMessage(event));
    await handle(kafkaMessage(event));
    await handle(kafkaMessage(event));

    expect(adapter.sent).toHaveLength(1);
    // The same shop is told again about a different event.
    await handle(kafkaMessage(suspended(event.payload.vendor_id)));
    expect(adapter.sent).toHaveLength(2);
  });

  it('claims with event_id and vendor id, under its own Redis prefix', async () => {
    const keys: string[] = [];
    const redis = {
      set: (key: string) => {
        keys.push(key);
        return Promise.resolve('OK' as const);
      },
      del: () => Promise.resolve(1),
    };
    const event = adPaused();
    const consumer = vendorNoticeConsumer({
      notifications: new RecordingAdapter(),
      contacts: NO_CONTACTS,
      deduplicator: new RedisEventDeduplicator(redis, VENDOR_NOTICE_DEDUPE_PREFIX),
      onSent: () => undefined,
    });

    await consumer.handle(kafkaMessage(event));

    expect(keys).toEqual([
      `notifications:notice:seen:${event.event_id}:${event.payload.vendor_id}`,
    ]);
  });

  it('tells every shop of a campaign change once, reading their numbers at that moment', async () => {
    const [first, second, gone] = [randomUUID(), randomUUID(), randomUUID()];
    const contacts = contactsOf({ [first]: '+9779800000021', [second]: '+9779800000022' });
    const { adapter, handle } = harness(contacts);
    const event = termsChanged([first, second, gone]);

    await handle(kafkaMessage(event));
    await handle(kafkaMessage(event));

    // A shop that can no longer be reached (deactivated, or unknown) is simply not told.
    expect(adapter.sent.map((notice) => [notice.vendorId, notice.phone])).toEqual([
      [first, '+9779800000021'],
      [second, '+9779800000022'],
    ]);
    expect(contacts.asked[0]).toEqual([first, second, gone]);
  });

  it('retries only the shops the adapter refused, and tells nobody twice', async () => {
    const [first, second, third] = [randomUUID(), randomUUID(), randomUUID()];
    const { adapter, deduplicator, handle } = harness(
      contactsOf({
        [first]: '+9779800000021',
        [second]: '+9779800000022',
        [third]: '+9779800000023',
      }),
    );
    const event = termsChanged([first, second, third]);
    adapter.failFor.add(second);

    await expect(handle(kafkaMessage(event))).rejects.toThrow(`provider refused ${second}`);

    // The shop after the failure was still told; only the failed claim was given back.
    expect(adapter.sent.map((notice) => notice.vendorId)).toEqual([first, third]);
    expect(deduplicator.claims.has(`${event.event_id}:${second}`)).toBe(false);
    expect(deduplicator.claims.has(`${event.event_id}:${first}`)).toBe(true);

    adapter.failFor.clear();
    await handle(kafkaMessage(event));

    expect(adapter.sent.map((notice) => notice.vendorId)).toEqual([first, third, second]);
  });

  it('reports every failure when several shops are refused', async () => {
    const [first, second] = [randomUUID(), randomUUID()];
    const { adapter, handle } = harness(
      contactsOf({ [first]: '+9779800000021', [second]: '+9779800000022' }),
    );
    adapter.failFor.add(first).add(second);

    await expect(handle(kafkaMessage(termsChanged([first, second])))).rejects.toBeInstanceOf(
      AggregateError,
    );
    expect(adapter.sent).toEqual([]);
  });

  it('claims nothing and sends nothing for other events and for an unparseable message', async () => {
    const { adapter, deduplicator, handle } = harness();
    const debt = {
      event_id: randomUUID(),
      event_type: 'vendor.suspended_for_debt',
      event_version: 1,
      occurred_at: AT,
      aggregate_id: randomUUID(),
      payload: {
        vendor_id: randomUUID(),
        vendor_phone: PHONE,
        previous_status: 'LIVE',
        wallet_balance_npr: -2500,
        suspension_limit_npr: -2000,
        suspended_at: AT,
      },
    };

    await handle(kafkaMessage(debt));
    // The poison pill is the other consumer's to dead-letter: here it is passed over, not thrown.
    await handle(kafkaMessage(null, '{"event_type":"marketing.ad_ended","payload":{}}'));
    await handle(kafkaMessage(null, 'not json'));
    await handle(kafkaMessage({ ...suspended(), payload: { vendor_id: 'x' } }));

    expect(adapter.sent).toEqual([]);
    expect(deduplicator.claims.size).toBe(0);
  });

  it('is wired after the debt and escalation SMS on the topic, with its own dead letters', async () => {
    const claims = new Set<string>();
    const lines: string[] = [];
    const smsSent: string[] = [];
    const deadLetters: string[] = [];
    const handlers = routeByTopic(
      buildConsumers({
        redis: {
          set: (key: string) => {
            if (claims.has(key)) return Promise.resolve(null);
            claims.add(key);
            return Promise.resolve('OK');
          },
          del: (key: string) => {
            claims.delete(key);
            return Promise.resolve(1);
          },
          publish: () => Promise.resolve(1),
        } as never,
        vendorAcceptanceTimers: { schedule: () => Promise.resolve() },
        sms: {
          provider: 'MOCK',
          send: (message: { text: string }) => {
            smsSent.push(message.text);
            return Promise.resolve({ provider: 'MOCK', providerMessageId: null });
          },
        } as never,
        ivr: null,
        orders: { currentState: () => Promise.resolve(null) },
        deadLetters: {
          publish: (record: { headers: Record<string, unknown> }) => {
            deadLetters.push(String(record.headers.dlq_consumer));
            return Promise.resolve();
          },
        } as never,
        deadLetterStore: { save: () => Promise.resolve() },
        push: { send: () => Promise.resolve([]) },
        pushRecipients: {} as never,
        pushSmsFallbackLog: null,
        notifications: new LoggerNotificationAdapter((line) => lines.push(line)),
        vendorContacts: NO_CONTACTS,
      }),
    );
    const info = jest.spyOn(console, 'info').mockImplementation(() => undefined);
    const event = suspended();

    await handlers.get('notifications.broadcast')?.(kafkaMessage(event));
    await handlers.get('notifications.broadcast')?.(kafkaMessage(event));

    // Logged once, and the SMS provider of the debt notices was not used for it.
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain(`[notify:sms] to ${PHONE}: Hamro Pasal: your shop is offline`);
    expect(smsSent).toEqual([]);
    expect(deadLetters).toEqual([]);
    info.mockRestore();
  });
});
