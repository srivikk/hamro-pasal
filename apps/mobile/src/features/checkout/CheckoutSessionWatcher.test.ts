import { router } from 'expo-router';

import { useCheckoutStore } from '../../store/useCheckoutStore';
import { useOrderStore } from '../../store/useOrderStore';
import { checkoutResponse, lockStatusResponse, ORDER_ID } from '../../test/api-fixtures';
import { followPlacedOrder, subscribeToPlacedOrders } from './CheckoutSessionWatcher';

jest.mock('expo-router', () => ({ router: { push: jest.fn() } }));
const mockPush = jest.mocked(router.push);

const OTHER_ORDER = '99999999-9999-4999-8999-999999999999';

describe('navigation to order tracking once an order is placed', () => {
  let onPlaced: jest.Mock;
  let unsubscribe: () => void;

  beforeEach(() => {
    useCheckoutStore.setState({
      session: null,
      attempt: null,
      deliveryOtp: null,
      sessionExpired: false,
    });
    useOrderStore.setState({ orders: {} });
    mockPush.mockReset();
    onPlaced = jest.fn();
    unsubscribe = subscribeToPlacedOrders(onPlaced);
  });

  afterEach(() => {
    unsubscribe();
  });

  it('fires at once for a COD order (PLACED at checkout)', () => {
    useCheckoutStore
      .getState()
      .startSession(checkoutResponse({ order: { state: 'PLACED', payment_method: 'COD' } }));

    expect(onPlaced).toHaveBeenCalledTimes(1);
    expect(onPlaced).toHaveBeenCalledWith(expect.objectContaining({ orderId: ORDER_ID }));
  });

  it('fires when a prepaid payment is confirmed, not while it is pending', () => {
    useCheckoutStore.getState().startSession(checkoutResponse());
    expect(onPlaced).not.toHaveBeenCalled();

    useCheckoutStore.getState().applyPaymentView({
      order_id: ORDER_ID,
      order_state: 'PLACED',
      payment_status: 'PAID',
      duplicate: false,
    });

    expect(onPlaced).toHaveBeenCalledTimes(1);
  });

  it('fires when the lock-status poll reports the order placed', () => {
    useCheckoutStore.getState().startSession(checkoutResponse());

    useCheckoutStore
      .getState()
      .applyLockStatus(
        lockStatusResponse(
          { status: 'RELEASED', ttl_ms: 0, expires_at: null },
          { state: 'PLACED' },
        ),
      );

    expect(onPlaced).toHaveBeenCalledTimes(1);
  });

  it('fires only once per order, however often the placed state is re-applied', () => {
    useCheckoutStore.getState().startSession(checkoutResponse());
    const confirm = () => {
      useCheckoutStore.getState().setOrderState(ORDER_ID, 'PLACED');
    };

    confirm();
    confirm();
    useCheckoutStore
      .getState()
      .applyLockStatus(
        lockStatusResponse(
          { status: 'RELEASED', ttl_ms: 0, expires_at: null },
          { state: 'PLACED' },
        ),
      );

    expect(onPlaced).toHaveBeenCalledTimes(1);
  });

  it('fires again for the next order', () => {
    useCheckoutStore
      .getState()
      .startSession(checkoutResponse({ order: { state: 'PLACED', payment_method: 'COD' } }));
    useCheckoutStore
      .getState()
      .startSession(
        checkoutResponse({ order: { id: OTHER_ORDER, state: 'PLACED', payment_method: 'COD' } }),
      );

    expect(onPlaced).toHaveBeenCalledTimes(2);
  });

  it('never fires for failed or cancelled orders', () => {
    useCheckoutStore.getState().startSession(checkoutResponse());
    useCheckoutStore.getState().setOrderState(ORDER_ID, 'FAILED');
    useCheckoutStore.getState().expireSession();

    expect(onPlaced).not.toHaveBeenCalled();
  });

  it('starts the 60 s window and opens the tracking screen with only the order id', () => {
    const placedAt = Date.parse('2026-09-29T10:00:00.000Z');

    followPlacedOrder(
      {
        orderId: ORDER_ID,
        reservationId: null,
        expiresAt: null,
        orderState: 'PLACED',
        paymentMethod: 'KHALTI',
        totalNpr: 1250,
      },
      placedAt,
    );

    expect(useOrderStore.getState().orders[ORDER_ID]).toEqual({
      orderId: ORDER_ID,
      placedAt,
      state: 'PLACED',
      paymentMethod: 'KHALTI',
      totalNpr: 1250,
    });
    // The OTP never travels in route params (they can end up in logs and deep links).
    expect(mockPush).toHaveBeenCalledWith({ pathname: '/order/[id]', params: { id: ORDER_ID } });
  });
});
