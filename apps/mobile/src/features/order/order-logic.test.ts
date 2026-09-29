import {
  cancellationRemainingMs,
  CANCELLATION_WINDOW_MS,
  canCancel,
  displayedOrderState,
} from './cancellation-window';
import { isTerminalOrderState, TRACKER_STEPS, trackerNodes } from './order-tracker';

const PLACED_AT = Date.parse('2026-09-29T10:00:00.000Z');

describe('cancellation window (SPEC journey step 8)', () => {
  it('lasts exactly 60 seconds', () => {
    expect(CANCELLATION_WINDOW_MS).toBe(60_000);
  });

  it.each([
    [0, 60_000],
    [1, 59_999],
    [45_000, 15_000],
    [59_999, 1],
    [60_000, 0],
    [3_600_000, 0],
  ])('%p ms after placement leaves %p ms', (elapsed, remaining) => {
    expect(cancellationRemainingMs(PLACED_AT, PLACED_AT + elapsed)).toBe(remaining);
  });

  it('cannot be stretched by a device clock set backwards', () => {
    expect(cancellationRemainingMs(PLACED_AT, PLACED_AT - 10 * 60_000)).toBe(60_000);
  });

  it('is closed when the placement time is unknown', () => {
    expect(cancellationRemainingMs(null, PLACED_AT)).toBe(0);
    expect(canCancel('PLACED', null, PLACED_AT)).toBe(false);
  });

  it('allows cancelling only a PLACED order inside the window', () => {
    expect(canCancel('PLACED', PLACED_AT, PLACED_AT + 59_999)).toBe(true);
    expect(canCancel('PLACED', PLACED_AT, PLACED_AT + 60_000)).toBe(false);
    expect(canCancel('PREPARING', PLACED_AT, PLACED_AT + 1_000)).toBe(false);
    expect(canCancel('CANCELED', PLACED_AT, PLACED_AT + 1_000)).toBe(false);
  });

  it('shows a still-PLACED order as PREPARING once the window closes, without rewriting later states', () => {
    expect(displayedOrderState('PLACED', true)).toBe('PLACED');
    expect(displayedOrderState('PLACED', false)).toBe('PREPARING');
    expect(displayedOrderState('OUT_FOR_DELIVERY', false)).toBe('OUT_FOR_DELIVERY');
    expect(displayedOrderState('CANCELED', false)).toBe('CANCELED');
  });
});

describe('discrete state nodes (SPEC journey step 9)', () => {
  const statuses = (state: Parameters<typeof trackerNodes>[0]) =>
    trackerNodes(state)?.map(({ step, status }) => `${step}:${status}`);

  it('has five steps in order', () => {
    expect(TRACKER_STEPS).toEqual([
      'PLACED',
      'PREPARING',
      'OUT_FOR_DELIVERY',
      'ARRIVED',
      'DELIVERED',
    ]);
  });

  it('PLACED: first active, the rest pending', () => {
    expect(statuses('PLACED')).toEqual([
      'PLACED:active',
      'PREPARING:pending',
      'OUT_FOR_DELIVERY:pending',
      'ARRIVED:pending',
      'DELIVERED:pending',
    ]);
  });

  it('PREPARING: placed completed, preparing active', () => {
    expect(statuses('PREPARING')).toEqual([
      'PLACED:completed',
      'PREPARING:active',
      'OUT_FOR_DELIVERY:pending',
      'ARRIVED:pending',
      'DELIVERED:pending',
    ]);
  });

  it('OUT_FOR_DELIVERY: two completed, third active', () => {
    expect(statuses('OUT_FOR_DELIVERY')).toEqual([
      'PLACED:completed',
      'PREPARING:completed',
      'OUT_FOR_DELIVERY:active',
      'ARRIVED:pending',
      'DELIVERED:pending',
    ]);
  });

  it.each(['DELIVERED', 'DISPUTED'] as const)('%s: every step completed', (state) => {
    expect(trackerNodes(state)?.every((node) => node.status === 'completed')).toBe(true);
  });

  it.each(['PENDING_PAYMENT', 'CANCELED', 'FAILED'] as const)('%s: no tracker', (state) => {
    expect(trackerNodes(state)).toBeNull();
  });

  it('never has more than one active node', () => {
    for (const state of ['PLACED', 'PREPARING', 'OUT_FOR_DELIVERY', 'DELIVERED'] as const) {
      expect(
        trackerNodes(state)?.filter((node) => node.status === 'active').length ?? 0,
      ).toBeLessThanOrEqual(1);
    }
  });

  it('treats delivered, cancelled and failed orders as finished', () => {
    expect(isTerminalOrderState('DELIVERED')).toBe(true);
    expect(isTerminalOrderState('CANCELED')).toBe(true);
    expect(isTerminalOrderState('FAILED')).toBe(true);
    expect(isTerminalOrderState('PLACED')).toBe(false);
    expect(isTerminalOrderState('OUT_FOR_DELIVERY')).toBe(false);
  });
});
