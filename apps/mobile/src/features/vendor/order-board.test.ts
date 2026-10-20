import type { VendorOrderView } from '@hamro-pasal/shared-types';
import { act } from '@testing-library/react-native';

import { MAX_HANDED_OVER_ORDERS, useVendorBoardStore } from '../../store/useVendorBoardStore';
import { NEW_ORDER_ID, SECOND_ORDER_ID, vendorOrder } from '../../test/api-fixtures';
import { renderHookWithProviders } from '../../test/render';
import { buildBoard, elapsedMinutes, stageOf } from './order-board';
import { useMinuteClock } from '../../lib/useMinuteClock';

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

describe('stageOf: a fleet order', () => {
  it('stays under Ready until its delivery (the server does not announce the pickup yet)', () => {
    const fleet = vendorOrder({ state: 'OUT_FOR_DELIVERY', fulfillment: 'PLATFORM_FLEET' });
    expect(stageOf(fleet)).toBe('READY');
    expect(stageOf({ ...fleet, state: 'DELIVERED' })).toBe('HANDED_OVER');
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
    );

    expect(result.NEW.map((item) => item.order.id)).toEqual([NEW_ORDER_ID, SECOND_ORDER_ID]);
    expect(result.HANDED_OVER.map((item) => item.order.id)).toEqual([
      'aaaaaaaa-0000-4000-8000-000000000002',
      'aaaaaaaa-0000-4000-8000-000000000001',
    ]);
    expect(result.NEW.every((item) => item.customerName === null)).toBe(true);
  });

  it('never shows an order twice: what the server lists wins over the local record', () => {
    const live = vendorOrder({ state: 'OUT_FOR_DELIVERY', fulfillment: 'SELF_DELIVERY' });

    const result = buildBoard([live], [{ ...live, state: 'DELIVERED' }]);

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

    const result = buildBoard([own], [fleet]);

    expect(
      Object.fromEntries(result.READY.map((item) => [item.order.id, item.awaitingRider])),
    ).toEqual({
      [NEW_ORDER_ID]: true,
      [SECOND_ORDER_ID]: false,
    });
  });

  it('leaves orders that are not on the board out', () => {
    const result = buildBoard([vendorOrder({ state: 'CANCELED' })], []);
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

describe('useVendorBoardStore', () => {
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
