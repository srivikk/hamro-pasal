import type { VendorOrderView } from '@hamro-pasal/shared-types';
import { act } from '@testing-library/react-native';

import { MAX_HANDED_OVER_ORDERS, useVendorBoardStore } from '../../store/useVendorBoardStore';
import { NEW_ORDER_ID, SECOND_ORDER_ID, vendorOrder } from '../../test/api-fixtures';
import { renderHookWithProviders } from '../../test/render';
import { buildBoard, elapsedMinutes, stageOf } from './order-board';
import { useMinuteClock, useVendorOrderSimulator } from './useVendorOrderSimulator';
import {
  buildMockOrder,
  MAX_WAITING_MOCK_ORDERS,
  MOCK_ORDER_INTERVAL_MS,
  seedMockOrders,
} from './vendor-order-mocks';

const NOW = Date.parse('2026-10-07T06:00:00.000Z');
const minutesAgo = (minutes: number): string => new Date(NOW - minutes * 60_000).toISOString();
const board = () => useVendorBoardStore.getState();

beforeEach(() => {
  board().reset();
});

describe('stageOf', () => {
  it.each<[VendorOrderView['state'], VendorOrderView['fulfillment'], string | null]>([
    ['PLACED', 'SELF_DELIVERY', 'NEW'],
    ['PREPARING', 'PLATFORM_FLEET', 'PREPARING'],
    ['OUT_FOR_DELIVERY', 'SELF_DELIVERY', 'READY'],
    ['OUT_FOR_DELIVERY', 'PLATFORM_FLEET', 'READY'], // waiting for its rider
    ['OUT_FOR_DELIVERY', 'EMERGENCY_FLEET', 'READY'],
    ['DELIVERED', 'SELF_DELIVERY', 'HANDED_OVER'],
    ['CANCELED', 'SELF_DELIVERY', null],
    ['PENDING_PAYMENT', 'SELF_DELIVERY', null],
    ['FAILED', 'PLATFORM_FLEET', null],
  ])('%s (%s) is %s', (state, fulfillment, stage) => {
    expect(stageOf(vendorOrder({ state, fulfillment }))).toBe(stage);
  });
});

describe('stageOf: a fleet order and its rider', () => {
  it('stays under Ready until the rider confirms the pickup, then is Handed Over', () => {
    const fleet = vendorOrder({ state: 'OUT_FOR_DELIVERY', fulfillment: 'PLATFORM_FLEET' });
    expect(stageOf(fleet, false)).toBe('READY');
    expect(stageOf(fleet, true)).toBe('HANDED_OVER');
  });

  it("ignores a pickup for the shop's own delivery: only the customer's code hands it over", () => {
    const own = vendorOrder({ state: 'OUT_FOR_DELIVERY', fulfillment: 'SELF_DELIVERY' });
    expect(stageOf(own, true)).toBe('READY');
  });
});

describe('buildBoard', () => {
  it('lists the longest wait first in the working columns and the newest first in Handed Over', () => {
    const early = vendorOrder({ id: NEW_ORDER_ID, placed_at: minutesAgo(9) });
    const late = vendorOrder({ id: SECOND_ORDER_ID, placed_at: minutesAgo(2) });
    const delivered = (id: string, minutes: number) =>
      vendorOrder({ id, state: 'DELIVERED', placed_at: minutesAgo(minutes) });

    const result = buildBoard(
      [late, early],
      [
        delivered('aaaaaaaa-0000-4000-8000-000000000001', 50),
        delivered('aaaaaaaa-0000-4000-8000-000000000002', 20),
      ],
      [],
    );

    expect(result.NEW.map((item) => item.order.id)).toEqual([NEW_ORDER_ID, SECOND_ORDER_ID]);
    expect(result.HANDED_OVER.map((item) => item.order.id)).toEqual([
      'aaaaaaaa-0000-4000-8000-000000000002',
      'aaaaaaaa-0000-4000-8000-000000000001',
    ]);
    expect(result.NEW.every((item) => !item.mock && item.customerName === null)).toBe(true);
  });

  it('marks sample orders and carries their customer name', () => {
    const sample = buildMockOrder(0, NOW);

    const result = buildBoard([vendorOrder()], [], [sample]);

    expect(result.NEW).toHaveLength(2);
    expect(result.NEW.find((item) => item.mock)).toMatchObject({
      customerName: sample.customerName,
      stage: 'NEW',
    });
  });

  it('never shows an order twice: what the server lists wins over the local record', () => {
    const live = vendorOrder({ state: 'OUT_FOR_DELIVERY', fulfillment: 'SELF_DELIVERY' });

    const result = buildBoard([live], [{ ...live, state: 'DELIVERED' }], []);

    expect(result.READY).toHaveLength(1);
    expect(result.HANDED_OVER).toHaveLength(0);
  });

  it('flags a fleet order under Ready as waiting for its rider, and nothing else', () => {
    const fleet = vendorOrder({ state: 'OUT_FOR_DELIVERY', fulfillment: 'PLATFORM_FLEET' });
    const own = vendorOrder({
      id: SECOND_ORDER_ID,
      state: 'OUT_FOR_DELIVERY',
      fulfillment: 'SELF_DELIVERY',
    });

    const result = buildBoard([own], [fleet], []);

    expect(
      Object.fromEntries(result.READY.map((item) => [item.order.id, item.awaitingRider])),
    ).toEqual({
      [NEW_ORDER_ID]: true,
      [SECOND_ORDER_ID]: false,
    });
  });

  it('moves a fleet sample to Handed Over once its rider has picked it up', () => {
    const waiting = buildMockOrder(2, NOW, 'OUT_FOR_DELIVERY');

    expect(buildBoard([], [], [waiting]).READY).toHaveLength(1);
    expect(buildBoard([], [], [{ ...waiting, riderPickedUp: true }]).HANDED_OVER).toHaveLength(1);
  });

  it('leaves orders that are not on the board out', () => {
    const result = buildBoard([vendorOrder({ state: 'CANCELED' })], [], []);
    expect(Object.values(result).flat()).toHaveLength(0);
  });
});

describe('elapsedMinutes', () => {
  it('counts whole minutes since the order was placed', () => {
    expect(elapsedMinutes(minutesAgo(0), NOW)).toBe(0);
    expect(elapsedMinutes(new Date(NOW - 59_999).toISOString(), NOW)).toBe(0);
    expect(elapsedMinutes(minutesAgo(1), NOW)).toBe(1);
    expect(elapsedMinutes(minutesAgo(125), NOW)).toBe(125);
  });

  it('is never negative, and 0 for an unreadable time', () => {
    expect(elapsedMinutes(new Date(NOW + 300_000).toISOString(), NOW)).toBe(0);
    expect(elapsedMinutes('not a date', NOW)).toBe(0);
  });
});

describe('sample orders', () => {
  it('are deterministic per sequence, with a fleet order every third', () => {
    expect(buildMockOrder(4, NOW)).toEqual(buildMockOrder(4, NOW));
    expect(buildMockOrder(4, NOW).order.id).not.toBe(buildMockOrder(5, NOW).order.id);
    expect([0, 1, 2, 3, 4, 5].map((n) => buildMockOrder(n, NOW).order.fulfillment)).toEqual([
      'SELF_DELIVERY',
      'SELF_DELIVERY',
      'PLATFORM_FLEET',
      'SELF_DELIVERY',
      'SELF_DELIVERY',
      'PLATFORM_FLEET',
    ]);
  });

  it('add up: the total is the lines plus the delivery fee, and prepaid orders are paid', () => {
    for (const sequence of [0, 1, 2, 7]) {
      const { order } = buildMockOrder(sequence, NOW);
      const lines = order.items.reduce((sum, item) => sum + item.unit_price_npr * item.quantity, 0);
      expect(order.subtotal_npr).toBe(lines);
      expect(order.total_npr).toBe(lines + order.delivery_fee_npr);
      expect(order.payment_status).toBe(order.payment_method === 'COD' ? 'PENDING' : 'PAID');
      expect(order.placed_at).toBe(new Date(NOW).toISOString());
    }
  });

  it('seed one order into every column', () => {
    const seeded = buildBoard([], [], seedMockOrders(NOW));
    expect(
      Object.fromEntries(Object.entries(seeded).map(([stage, items]) => [stage, items.length])),
    ).toEqual({
      NEW: 1,
      PREPARING: 1,
      READY: 1,
      HANDED_OVER: 1,
    });
  });
});

describe('useVendorBoardStore', () => {
  it('seeds once', () => {
    board().seedMocks(NOW);
    const first = board().mocks;
    board().seedMocks(NOW + 60_000);

    expect(board().mocks).toBe(first);
    expect(first).toHaveLength(4);
  });

  it('lets a new order arrive, until too many wait unanswered', () => {
    for (let index = 0; index < MAX_WAITING_MOCK_ORDERS; index += 1) {
      expect(board().addIncomingMock(NOW + index)).toBe(true);
    }
    expect(board().addIncomingMock(NOW + 99)).toBe(false);
    expect(board().mocks).toHaveLength(MAX_WAITING_MOCK_ORDERS);

    // Answering one makes room again.
    const [first] = board().mocks;
    board().setMockState(first?.order.id ?? '', 'PREPARING');
    expect(board().addIncomingMock(NOW + 100)).toBe(true);
    expect(new Set(board().mocks.map((entry) => entry.order.id)).size).toBe(
      MAX_WAITING_MOCK_ORDERS + 1,
    );
  });

  it('moves and removes a sample order', () => {
    board().addIncomingMock(NOW);
    const id = board().mocks[0]?.order.id ?? '';

    board().setMockState(id, 'PREPARING');
    expect(board().mocks[0]?.order.state).toBe('PREPARING');

    board().removeMock(id);
    expect(board().mocks).toHaveLength(0);
  });

  it('keeps only the newest finished sample orders (the screen is open all day)', () => {
    for (let index = 0; index < MAX_HANDED_OVER_ORDERS + 5; index += 1) {
      board().addIncomingMock(NOW + index);
      const id = board().mocks.at(-1)?.order.id ?? '';
      board().setMockState(id, 'DELIVERED');
    }

    expect(board().mocks).toHaveLength(MAX_HANDED_OVER_ORDERS);
    expect(board().mocks[0]?.order.placed_at).toBe(new Date(NOW + 5).toISOString());
  });

  it('marks a fleet sample as picked up by its rider', () => {
    useVendorBoardStore.setState({ mocks: [buildMockOrder(2, NOW, 'OUT_FOR_DELIVERY')] });
    const id = board().mocks[0]?.order.id ?? '';

    board().markMockPickedUp(id);

    expect(board().mocks[0]?.riderPickedUp).toBe(true);
  });

  it('follows an order it remembers: delivered moves it on, canceled or failed removes it', () => {
    const fleet = vendorOrder({ state: 'OUT_FOR_DELIVERY', fulfillment: 'PLATFORM_FLEET' });
    const other = vendorOrder({
      id: SECOND_ORDER_ID,
      state: 'OUT_FOR_DELIVERY',
      fulfillment: 'PLATFORM_FLEET',
    });
    board().recordDeparted(fleet);
    board().recordDeparted(other);

    board().settleDeparted(NEW_ORDER_ID, 'OUT_FOR_DELIVERY');
    expect(board().departed.find((order) => order.id === NEW_ORDER_ID)?.state).toBe(
      'OUT_FOR_DELIVERY',
    );

    board().settleDeparted(NEW_ORDER_ID, 'DELIVERED');
    expect(board().departed.find((order) => order.id === NEW_ORDER_ID)?.state).toBe('DELIVERED');

    board().settleDeparted(SECOND_ORDER_ID, 'FAILED');
    expect(board().departed.map((order) => order.id)).toEqual([NEW_ORDER_ID]);

    const before = board().departed;
    board().settleDeparted('an-order-it-never-saw', 'DELIVERED');
    expect(board().departed).toBe(before);
  });

  it('records handed-over live orders newest first, once each, and caps the list', () => {
    const order = vendorOrder({ state: 'DELIVERED' });
    board().recordDeparted(order);
    board().recordDeparted(vendorOrder({ id: SECOND_ORDER_ID, state: 'DELIVERED' }));
    board().recordDeparted(order);

    expect(board().departed.map((each) => each.id)).toEqual([NEW_ORDER_ID, SECOND_ORDER_ID]);

    for (let index = 0; index < MAX_HANDED_OVER_ORDERS + 3; index += 1) {
      board().recordDeparted(
        vendorOrder({ id: `bbbbbbbb-0000-4000-8000-${String(index).padStart(12, '0')}` }),
      );
    }
    expect(board().departed).toHaveLength(MAX_HANDED_OVER_ORDERS);
  });
});

describe('useVendorOrderSimulator', () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: NOW });
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('seeds the board at once and adds a new order every 30 seconds', () => {
    renderHookWithProviders(() => {
      useVendorOrderSimulator(true);
    });
    expect(board().mocks).toHaveLength(4);

    act(() => {
      jest.advanceTimersByTime(MOCK_ORDER_INTERVAL_MS - 1);
    });
    expect(board().mocks).toHaveLength(4);

    act(() => {
      jest.advanceTimersByTime(1);
    });
    expect(board().mocks).toHaveLength(5);
    expect(board().mocks.at(-1)?.order).toMatchObject({
      state: 'PLACED',
      placed_at: new Date(NOW + MOCK_ORDER_INTERVAL_MS).toISOString(),
    });

    act(() => {
      jest.advanceTimersByTime(MOCK_ORDER_INTERVAL_MS);
    });
    expect(board().mocks).toHaveLength(6);
  });

  it('does nothing while disabled, and stops when it is switched off or unmounted', () => {
    const hook = renderHookWithProviders(
      ({ enabled }: { enabled: boolean }) => {
        useVendorOrderSimulator(enabled);
      },
      { initialProps: { enabled: false } },
    );
    act(() => {
      jest.advanceTimersByTime(MOCK_ORDER_INTERVAL_MS * 3);
    });
    expect(board().mocks).toHaveLength(0);

    hook.rerender({ enabled: true });
    act(() => {
      jest.advanceTimersByTime(MOCK_ORDER_INTERVAL_MS);
    });
    expect(board().mocks).toHaveLength(5);

    hook.rerender({ enabled: false });
    act(() => {
      jest.advanceTimersByTime(MOCK_ORDER_INTERVAL_MS * 3);
    });
    expect(board().mocks).toHaveLength(5); // the orders stay, no new one arrives

    hook.rerender({ enabled: true });
    hook.unmount();
    expect(jest.getTimerCount()).toBe(0);
  });
});

describe('useMinuteClock', () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: NOW + 20_000 });
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('changes once a minute, not on every check, and clears its timer', () => {
    let renders = 0;
    const hook = renderHookWithProviders(() => {
      renders += 1;
      return useMinuteClock();
    });
    expect(hook.result.current).toBe(NOW + 20_000);
    const initialRenders = renders;

    act(() => {
      jest.advanceTimersByTime(30_000); // two checks inside the same minute
    });
    expect(hook.result.current).toBe(NOW + 20_000);
    expect(renders).toBe(initialRenders);

    act(() => {
      jest.advanceTimersByTime(15_000);
    });
    expect(hook.result.current).toBe(NOW + 65_000);

    hook.unmount();
    expect(jest.getTimerCount()).toBe(0);
  });
});
