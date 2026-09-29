import { ApiError } from '../../api/http';
import { CANCELLATION_WINDOW_EXPIRED, cancelOrder } from './mock-cancel-api';

const ORDER_ID = '0b9f2b8e-7c1d-4a51-9a3e-2f6d8c4b1a70';

describe('cancelOrder (mock of POST /api/orders/:id/cancel)', () => {
  it('cancels inside the 60 s window', async () => {
    await expect(
      cancelOrder(ORDER_ID, 1_000_000, { latencyMs: 0, nowMs: () => 1_000_000 + 59_000 }),
    ).resolves.toEqual({ order_id: ORDER_ID, state: 'CANCELED' });
  });

  it('answers like the server once the window has closed: 422 CANCELLATION_WINDOW_EXPIRED', async () => {
    const error: unknown = await cancelOrder(ORDER_ID, 1_000_000, {
      latencyMs: 0,
      nowMs: () => 1_000_000 + 61_000,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 422, code: 'CANCELLATION_WINDOW_EXPIRED' });
    expect(CANCELLATION_WINDOW_EXPIRED).toBe('CANCELLATION_WINDOW_EXPIRED');
  });
});
