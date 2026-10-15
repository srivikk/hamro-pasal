import { randomUUID } from 'node:crypto';

import type { KafkaJS } from '@hamro-pasal/kafka';
import type { DomainEvent } from '@hamro-pasal/shared-types';

import { backInStockText, shopOpenText } from '../notifications/notify-me';
import { notifyMeConsumer } from './notify-me';

const AT = '2026-10-15T08:00:00.000Z';

function kafkaMessage(event: unknown, raw?: string): KafkaJS.EachMessagePayload {
  return {
    topic: 'notifications.broadcast',
    partition: 0,
    message: { value: Buffer.from(raw ?? JSON.stringify(event)), offset: '7' },
  } as unknown as KafkaJS.EachMessagePayload;
}

function envelope<T extends DomainEvent['event_type']>(
  type: T,
  payload: Extract<DomainEvent, { event_type: T }>['payload'],
): DomainEvent {
  return {
    event_id: randomUUID(),
    event_type: type,
    event_version: 1,
    occurred_at: AT,
    aggregate_id: randomUUID(),
    payload,
  } as DomainEvent;
}

function fakeNotifyMe() {
  return {
    productBackInStock: jest.fn((_id: string) => Promise.resolve({ notified: 1 })),
    shopOpened: jest.fn((_id: string) => Promise.resolve({ notified: 0 })),
  };
}

describe('notifyMeConsumer (step 7.4)', () => {
  beforeEach(() => {
    jest.spyOn(console, 'info').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('tells the customers waiting for a product that is back in stock', async () => {
    const notifyMe = fakeNotifyMe();
    const productId = randomUUID();
    await notifyMeConsumer({ notifyMe }).handle(
      kafkaMessage(
        envelope('product.back_in_stock', { product_id: productId, vendor_id: randomUUID() }),
      ),
    );

    expect(notifyMe.productBackInStock).toHaveBeenCalledWith(productId);
    expect(notifyMe.shopOpened).not.toHaveBeenCalled();
  });

  it('tells the customers waiting for a shop that opened', async () => {
    const notifyMe = fakeNotifyMe();
    const vendorId = randomUUID();
    await notifyMeConsumer({ notifyMe }).handle(
      kafkaMessage(envelope('vendor.opened', { vendor_id: vendorId, opened_at: AT })),
    );

    expect(notifyMe.shopOpened).toHaveBeenCalledWith(vendorId);
  });

  it('ignores other events and leaves an unparseable envelope to the dead-lettering consumer', async () => {
    const notifyMe = fakeNotifyMe();
    const consumer = notifyMeConsumer({ notifyMe });
    await consumer.handle(
      kafkaMessage(
        envelope('vendor.reactivated', {
          vendor_id: randomUUID(),
          vendor_phone: '+9779800000011',
          reactivated_at: AT,
        } as never),
      ),
    );
    await consumer.handle(kafkaMessage(null, '{not json'));

    expect(notifyMe.productBackInStock).not.toHaveBeenCalled();
    expect(notifyMe.shopOpened).not.toHaveBeenCalled();
  });

  it('lets a failure through, so the message is retried and dead-lettered', async () => {
    const notifyMe = fakeNotifyMe();
    notifyMe.shopOpened.mockRejectedValueOnce(new Error('database down'));

    await expect(
      notifyMeConsumer({ notifyMe }).handle(
        kafkaMessage(envelope('vendor.opened', { vendor_id: randomUUID(), opened_at: AT })),
      ),
    ).rejects.toThrow('database down');
  });
});

describe('Notify Me wording', () => {
  it('names the product and the shop, in English and Nepali', () => {
    expect(backInStockText('en', 'Basmati Rice', 'Thamel Kirana Pasal')).toEqual({
      title: 'Back in stock',
      body: 'Basmati Rice is back in stock at Thamel Kirana Pasal.',
    });
    expect(backInStockText('ne', 'Basmati Rice', 'Thamel Kirana Pasal').body).toBe(
      'Thamel Kirana Pasal मा Basmati Rice फेरि उपलब्ध छ।',
    );
    expect(shopOpenText('en', 'Thamel Kirana Pasal').title).toBe('Shop open');
    expect(shopOpenText('ne', 'Thamel Kirana Pasal').title).toBe('पसल खुल्यो');
  });
});
