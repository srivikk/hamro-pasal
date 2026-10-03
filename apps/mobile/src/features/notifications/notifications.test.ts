import { Platform } from 'react-native';

import {
  mockNotifications,
  mockTasks,
  resetMockNotifications,
  scheduleNotificationAsync,
} from '../../test/fake-notifications';
import {
  configureForegroundNotifications,
  ensureOrderNotificationChannel,
  foregroundBehavior,
} from './notification-handler';
import {
  handleOrderPushTask,
  ORDER_PUSH_TASK,
  orderPushFromTaskPayload,
  registerOrderPushTask,
} from './order-push-task';

const DATA = {
  type: 'order.state_changed',
  notification_id: '0b0f2a0e-6a52-4a0d-8a43-3f5a4a1f6f10',
  order_id: '6f1d1c5e-6f0b-4e0e-9c57-0f6a3f1f8a11',
  state: 'OUT_FOR_DELIVERY',
  audience: 'CUSTOMER',
  data_only: true,
  title: 'Your order is on its way',
  body: 'Order #1F8A11 has left the shop. Keep your 4-digit delivery code ready.',
} as const;

const incoming = (title: string | null, body: string | null) => ({
  request: { content: { title, body } },
});

beforeEach(() => {
  resetMockNotifications();
  mockTasks.clear();
  jest.replaceProperty(Platform, 'OS', 'android');
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('foreground notification handler', () => {
  it('shows a banner with sound for a notification that arrives while the app is open', () => {
    expect(foregroundBehavior(incoming('Order accepted', 'The shop is preparing it.'))).toEqual({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
    });
  });

  it('shows nothing for a data-only push (the task posts its notification)', () => {
    expect(foregroundBehavior(incoming(null, null))).toEqual({
      shouldShowBanner: false,
      shouldShowList: false,
      shouldPlaySound: false,
      shouldSetBadge: false,
    });
    expect(foregroundBehavior(incoming('', '')).shouldShowBanner).toBe(false);
  });

  it('is installed by configureForegroundNotifications', async () => {
    expect(mockNotifications.handler).toBeNull();

    configureForegroundNotifications();

    expect(
      await mockNotifications.handler?.handleNotification(incoming('New order', 'Order #1F8A11')),
    ).toMatchObject({ shouldShowBanner: true, shouldShowList: true });
  });
});

describe('ensureOrderNotificationChannel', () => {
  it('creates the high-importance "orders" channel on Android, named in the app language', async () => {
    await ensureOrderNotificationChannel('अर्डर अपडेट');

    expect(mockNotifications.channels).toEqual([
      // The literal id: it must equal the channelId the worker sends.
      { id: 'orders', input: { name: 'अर्डर अपडेट', importance: 6, sound: 'default' } },
    ]);
  });

  it('does nothing on iOS', async () => {
    jest.replaceProperty(Platform, 'OS', 'ios');

    await ensureOrderNotificationChannel('Order updates');

    expect(mockNotifications.channels).toEqual([]);
  });
});

describe('orderPushFromTaskPayload', () => {
  it.each([
    ['Android: a JSON string in data.dataString', { data: { dataString: JSON.stringify(DATA) } }],
    ['Android FCM: a JSON string in data.body', { data: { body: JSON.stringify(DATA) } }],
    ['iOS: an object in data.body', { data: { body: DATA }, aps: { 'content-available': 1 } }],
    ['directly as data', { notification: null, data: DATA }],
  ])('reads the order push from %s', (_name, payload) => {
    expect(orderPushFromTaskPayload(payload)).toEqual(DATA);
  });

  it.each([
    ['a notification tap', { actionIdentifier: 'default', notification: {}, data: DATA }],
    ['another kind of push', { data: { dataString: JSON.stringify({ type: 'chat' }) } }],
    ['a broken JSON string', { data: { dataString: '{not json' } }],
    ['an unknown order state', { data: { ...DATA, state: 'ARRIVED' } }],
    ['no data', { notification: null }],
    ['nothing', null],
  ])('finds none in %s', (_name, payload) => {
    expect(orderPushFromTaskPayload(payload)).toBeNull();
  });
});

describe('handleOrderPushTask', () => {
  it('posts the visible notification of a data-only push on the orders channel', async () => {
    const result = await handleOrderPushTask({ data: { dataString: JSON.stringify(DATA) } });

    expect(result).toBe(0); // NewData
    expect(mockNotifications.scheduled).toEqual([
      {
        identifier: DATA.notification_id,
        content: {
          title: 'Your order is on its way',
          body: 'Order #1F8A11 has left the shop. Keep your 4-digit delivery code ready.',
          sound: 'default',
          data: { ...DATA, data_only: false },
        },
        trigger: { channelId: 'orders' },
      },
    ]);
  });

  it('delivers it at once on iOS (no channel)', async () => {
    jest.replaceProperty(Platform, 'OS', 'ios');

    await handleOrderPushTask({ data: { body: DATA } });

    expect(mockNotifications.scheduled).toMatchObject([{ trigger: null }]);
  });

  it('uses the event id as the identifier, so a push delivered twice does not stack', async () => {
    await handleOrderPushTask({ data: { dataString: JSON.stringify(DATA) } });
    await handleOrderPushTask({ data: { dataString: JSON.stringify(DATA) } });

    expect(
      mockNotifications.scheduled.map((request) => (request as { identifier: string }).identifier),
    ).toEqual([DATA.notification_id, DATA.notification_id]);
  });

  it('leaves a push that has its own title and body to the system', async () => {
    const result = await handleOrderPushTask({
      data: { dataString: JSON.stringify({ ...DATA, data_only: false }) },
    });

    expect(result).toBe(1); // NoData
    expect(mockNotifications.scheduled).toEqual([]);
  });

  it('ignores taps and foreign payloads', async () => {
    await handleOrderPushTask({ actionIdentifier: 'default', data: DATA });
    await handleOrderPushTask({ data: { dataString: '{"type":"chat"}' } });

    expect(mockNotifications.scheduled).toEqual([]);
  });

  it('reports Failed when the notification cannot be posted', async () => {
    scheduleNotificationAsync.mockRejectedValueOnce(new Error('no permission'));

    expect(await handleOrderPushTask({ data: DATA })).toBe(2); // Failed
  });
});

describe('registerOrderPushTask', () => {
  it('defines the task and registers it with expo-notifications, once', async () => {
    registerOrderPushTask();
    registerOrderPushTask();

    expect([...mockTasks.keys()]).toEqual([ORDER_PUSH_TASK]);
    expect(mockNotifications.registeredTasks).toEqual([ORDER_PUSH_TASK, ORDER_PUSH_TASK]);

    // The defined task is the handler: running it posts the notification.
    await mockTasks.get(ORDER_PUSH_TASK)?.({ data: { data: DATA }, error: null });
    expect(mockNotifications.scheduled).toHaveLength(1);
  });

  it('does nothing on the web', () => {
    jest.replaceProperty(Platform, 'OS', 'web');

    registerOrderPushTask();

    expect(mockTasks.size).toBe(0);
    expect(mockNotifications.registeredTasks).toEqual([]);
  });
});
