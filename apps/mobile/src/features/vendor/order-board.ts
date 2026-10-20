import type { VendorOrderView } from '@hamro-pasal/shared-types';

/** The dashboard's columns, in the order an order moves through them. */
export const BOARD_STAGES = ['NEW', 'PREPARING', 'READY', 'HANDED_OVER'] as const;
export type BoardStage = (typeof BOARD_STAGES)[number];

export interface BoardOrder {
  order: VendorOrderView;
  stage: BoardStage;
  /** First name only (the privacy rule for vendors). Null for now: the API sends none yet. */
  customerName: string | null;
  /** A fleet order under Ready: the riders have been told, none has collected it yet. */
  awaitingRider: boolean;
}

export type Board = Record<BoardStage, BoardOrder[]>;

/**
 * Where an order sits on the board. SPEC's `OrderState` has no "ready" state, so the columns are a
 * view of the existing ones:
 *  - New: PLACED (waiting for Accept / Reject)
 *  - Preparing: PREPARING
 *  - Ready: OUT_FOR_DELIVERY and still in the shop. The shop's own delivery waits for the
 *    customer's code; a fleet order waits for its rider (the dispatch told the riders). The
 *    server does not announce a rider's pickup yet, so a fleet order stays here until delivered.
 *  - Handed Over: any DELIVERED order
 * Any other state (canceled, failed, awaiting payment) is not on the board.
 */
export function stageOf(order: VendorOrderView): BoardStage | null {
  switch (order.state) {
    case 'PLACED':
      return 'NEW';
    case 'PREPARING':
      return 'PREPARING';
    case 'OUT_FOR_DELIVERY':
      return 'READY';
    case 'DELIVERED':
      return 'HANDED_OVER';
    default:
      return null;
  }
}

const placedMs = (entry: BoardOrder): number => Date.parse(entry.order.placed_at);

/**
 * The board: the server's open orders and the orders this device saw leave the server's list
 * (`departed`: a fleet order it dispatched, an order it delivered). Work still to do is listed
 * oldest first (the longest wait on top); Handed Over is newest first. An order the server still
 * lists is never shown twice.
 */
export function buildBoard(
  live: readonly VendorOrderView[],
  departed: readonly VendorOrderView[],
): Board {
  const board: Board = { NEW: [], PREPARING: [], READY: [], HANDED_OVER: [] };
  const seen = new Set<string>();
  const place = (order: VendorOrderView): void => {
    const stage = stageOf(order);
    if (stage === null || seen.has(order.id)) return;
    seen.add(order.id);
    const awaitingRider = stage === 'READY' && order.fulfillment !== 'SELF_DELIVERY';
    board[stage].push({ order, stage, customerName: null, awaitingRider });
  };

  for (const order of live) place(order);
  for (const order of departed) place(order);

  for (const stage of BOARD_STAGES) {
    board[stage].sort((a, b) =>
      stage === 'HANDED_OVER' ? placedMs(b) - placedMs(a) : placedMs(a) - placedMs(b),
    );
  }
  return board;
}

/** Whole minutes since the order was placed, never negative (a device clock may run behind). */
export function elapsedMinutes(placedAt: string, nowMs: number): number {
  const placed = Date.parse(placedAt);
  if (Number.isNaN(placed)) return 0;
  return Math.max(0, Math.floor((nowMs - placed) / 60_000));
}
