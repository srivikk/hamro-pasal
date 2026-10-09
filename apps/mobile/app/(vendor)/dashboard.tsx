import type { OrderStateUpdate } from '@hamro-pasal/shared-types';
import { router, Stack } from 'expo-router';
import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Platform,
  Pressable,
  RefreshControl,
  Text,
  View,
  type ListRenderItem,
} from 'react-native';
import { useTranslation } from 'react-i18next';

import { Button } from '../../src/components/Button';
import {
  BOARD_STAGES,
  buildBoard,
  elapsedMinutes,
  type BoardOrder,
  type BoardStage,
} from '../../src/features/vendor/order-board';
import { OrderStageTabs } from '../../src/features/vendor/OrderStageTabs';
import { useTaxIdentityQuery } from '../../src/features/vendor/usePanDocument';
import {
  useMinuteClock,
  useVendorOrderSimulator,
} from '../../src/features/vendor/useVendorOrderSimulator';
import {
  isAlarmRinging,
  useVendorDelivery,
  useVendorDispatch,
  useVendorOrderDecisions,
  useVendorOrdersQuery,
  useVendorOrdersRealtime,
} from '../../src/features/vendor/useVendorOrders';
import { useVendorAlarm } from '../../src/features/vendor/vendor-alarm';
import { VENDOR_ORDER_MOCKS_ENABLED } from '../../src/features/vendor/vendor-order-mocks';
import { VendorOrderCard } from '../../src/features/vendor/VendorOrderCard';
import { useToastStore } from '../../src/store/useToastStore';
import { useVendorBoardStore } from '../../src/store/useVendorBoardStore';
import { useVendorShopStore } from '../../src/store/useVendorShopStore';

type OrderAction = (item: BoardOrder) => void;

/** An order the board remembers was delivered, canceled or failed: follow it. */
function settleDeparted(update: OrderStateUpdate): void {
  useVendorBoardStore.getState().settleDeparted(update.order_id, update.state);
}

interface BoardCardProps {
  item: BoardOrder;
  /** The clock, floored to the minute: the card re-renders with it once a minute at most. */
  nowMs: number;
  answered: boolean;
  dispatching: boolean;
  delivering: boolean;
  onAccept: OrderAction;
  onReject: OrderAction;
  onReady: OrderAction;
  onRiderPickup: OrderAction;
  onDeliver: (item: BoardOrder, otp: string, onRejected: () => void) => void;
}

/**
 * One row of the board. Memoised on the order and its own flags, with handlers that keep their
 * identity, so an update to one order (or a new arrival) re-renders that row and not the list.
 */
const BoardCard = memo(function BoardCard({
  item,
  nowMs,
  answered,
  dispatching,
  delivering,
  onAccept,
  onReject,
  onReady,
  onRiderPickup,
  onDeliver,
}: BoardCardProps) {
  const { t } = useTranslation();
  const minutes = elapsedMinutes(item.order.placed_at, nowMs);
  const elapsed =
    minutes < 1
      ? t('vendorDashboard.elapsedNow')
      : minutes < 60
        ? t('vendorDashboard.elapsedMinutes', { minutes })
        : t('vendorDashboard.elapsedHours', {
            hours: Math.floor(minutes / 60),
            minutes: minutes % 60,
          });
  return (
    <VendorOrderCard
      order={item.order}
      customerName={item.customerName}
      elapsed={elapsed}
      sample={item.mock}
      awaitingRider={item.awaitingRider}
      onRiderPickup={
        item.mock
          ? () => {
              onRiderPickup(item);
            }
          : undefined
      }
      answered={answered}
      onAccept={() => {
        onAccept(item);
      }}
      onReject={() => {
        onReject(item);
      }}
      dispatching={dispatching}
      onDispatch={() => {
        onReady(item);
      }}
      delivering={delivering}
      onDeliver={(otp, onRejected) => {
        onDeliver(item, otp, onRejected);
      }}
    />
  );
});

const keyOf = (item: BoardOrder): string => item.order.id;

/**
 * Vendor flow steps 6–9 as a board: New → Preparing → Ready → Handed Over, one column at a time.
 * A new order arrives over Socket.io `/orders` (the shop's room), pulses, and the alarm loops at
 * full volume until the vendor presses Accept or Reject on every waiting order. An accepted order
 * is Preparing until "Ready for Pickup", which dispatches it (refused until the customer's 60 s
 * cancellation window has closed) and moves it to Ready: the shop's own delivery waits there for
 * the customer's 4-digit code, a fleet order for its rider, whose pickup moves it to Handed Over. If the vendor does not answer a new
 * order within 90 s the backend escalates to an IVR call / SMS.
 *
 * Development builds also show sample orders (a new one every 30 s) so the board can be tried
 * without customers: see `vendor-order-mocks.ts`.
 */
export default function VendorDashboardScreen() {
  const { t } = useTranslation();
  const query = useVendorOrdersQuery();
  useVendorOrdersRealtime(true, undefined, settleDeparted);
  const { decide, acknowledged } = useVendorOrderDecisions();
  const { dispatch, pendingOrderId: dispatchingId } = useVendorDispatch();
  const { deliver, pendingOrderId: deliveringId } = useVendorDelivery();
  const ringing = isAlarmRinging(query.data, acknowledged);
  useVendorAlarm(ringing);

  const online = useVendorShopStore((state) => state.online);
  // Phase 37: the reminder follows what the server holds, not what this phone once saved. It
  // shows only once the answer is in: for a missing PAN, then for a missing certificate.
  const identity = useTaxIdentityQuery().data;
  const reminder =
    identity === undefined
      ? null
      : identity.tax_id === null
        ? 'panBanner'
        : identity.has_pan_document
          ? null
          : 'documentBanner';
  const toast = useToastStore((store) => store.show);
  const mocks = useVendorBoardStore((state) => state.mocks);
  const departed = useVendorBoardStore((state) => state.departed);
  useVendorOrderSimulator(VENDOR_ORDER_MOCKS_ENABLED && online);
  // The board's own record belongs to this sitting: it goes when the vendor signs out.
  useEffect(() => useVendorBoardStore.getState().reset, []);

  const nowMs = useMinuteClock();
  const [stage, setStage] = useState<BoardStage>('NEW');

  const live = query.data;
  const board = useMemo(
    () => buildBoard(live ?? [], departed, VENDOR_ORDER_MOCKS_ENABLED ? mocks : []),
    [live, departed, mocks],
  );
  const counts = useMemo(
    () => ({
      NEW: board.NEW.length,
      PREPARING: board.PREPARING.length,
      READY: board.READY.length,
      HANDED_OVER: board.HANDED_OVER.length,
    }),
    [board],
  );
  const unanswered = board.NEW.filter((item) => !acknowledged.has(item.order.id)).length;
  const total = BOARD_STAGES.reduce((sum, each) => sum + counts[each], 0);

  const onAccept = useCallback<OrderAction>(
    ({ order, mock }) => {
      if (!mock) {
        decide({ orderId: order.id, decision: 'accept' });
        return;
      }
      useVendorBoardStore.getState().setMockState(order.id, 'PREPARING');
      toast(t('vendorDashboard.accepted'), 'success');
    },
    [decide, t, toast],
  );
  const onReject = useCallback<OrderAction>(
    ({ order, mock }) => {
      if (!mock) {
        decide({ orderId: order.id, decision: 'reject' });
        return;
      }
      useVendorBoardStore.getState().removeMock(order.id);
      toast(t('vendorDashboard.rejected'), 'success');
    },
    [decide, t, toast],
  );
  const onReady = useCallback<OrderAction>(
    ({ order, mock }) => {
      const fleet = order.fulfillment !== 'SELF_DELIVERY';
      if (!mock) {
        dispatch(order.id, {
          onSuccess: () => {
            // The server stops listing a fleet order once the riders can take it; the board keeps
            // it under Ready until its delivery is announced.
            if (fleet) {
              useVendorBoardStore
                .getState()
                .recordDeparted({ ...order, state: 'OUT_FOR_DELIVERY' });
            }
          },
        });
        return;
      }
      useVendorBoardStore.getState().setMockState(order.id, 'OUT_FOR_DELIVERY');
      toast(t(fleet ? 'vendorDashboard.dispatchedFleet' : 'vendorDashboard.dispatched'), 'success');
    },
    [dispatch, t, toast],
  );
  const onRiderPickup = useCallback<OrderAction>(({ order }) => {
    useVendorBoardStore.getState().markMockPickedUp(order.id);
  }, []);
  const onDeliver = useCallback<BoardCardProps['onDeliver']>(
    ({ order, mock }, otp, onRejected) => {
      if (!mock) {
        deliver(
          { orderId: order.id, otp },
          {
            onError: onRejected,
            onSuccess: () => {
              useVendorBoardStore.getState().recordDeparted({ ...order, state: 'DELIVERED' });
            },
          },
        );
        return;
      }
      // A sample order has no real code: any four digits hand it over.
      useVendorBoardStore.getState().setMockState(order.id, 'DELIVERED');
      toast(t('delivery.delivered'), 'success');
    },
    [deliver, t, toast],
  );

  const renderItem = useCallback<ListRenderItem<BoardOrder>>(
    ({ item }) => (
      <BoardCard
        item={item}
        nowMs={nowMs}
        answered={acknowledged.has(item.order.id)}
        dispatching={dispatchingId === item.order.id}
        delivering={deliveringId === item.order.id}
        onAccept={onAccept}
        onReject={onReject}
        onReady={onReady}
        onRiderPickup={onRiderPickup}
        onDeliver={onDeliver}
      />
    ),
    [
      acknowledged,
      deliveringId,
      dispatchingId,
      nowMs,
      onAccept,
      onDeliver,
      onReady,
      onReject,
      onRiderPickup,
    ],
  );

  const header = (
    <Stack.Screen options={{ headerShown: true, title: t('vendorDashboard.title') }} />
  );

  // Without sample orders there is nothing to show until the server has answered.
  if (live === undefined && !VENDOR_ORDER_MOCKS_ENABLED) {
    return (
      <View className="flex-1 items-center justify-center gap-4 bg-gray-50 px-6">
        {header}
        {query.isError ? (
          <>
            <Text className="text-center text-base text-gray-700">
              {t('vendorDashboard.loadError')}
            </Text>
            <Button label={t('common.retry')} onPress={() => void query.refetch()} />
          </>
        ) : (
          <ActivityIndicator testID="vendor-orders-loading" />
        )}
      </View>
    );
  }

  return (
    <View className="flex-1 bg-gray-50">
      {header}
      {ringing ? (
        <View className="bg-red-600 px-4 py-3" testID="vendor-alarm-banner">
          <Text className="text-base font-bold text-white">{t('vendorDashboard.alarm')}</Text>
        </View>
      ) : null}
      {online ? null : (
        <View className="bg-gray-800 px-4 py-3" testID="vendor-offline-banner">
          <Text className="text-sm font-semibold text-white">{t('vendorShop.offlineBanner')}</Text>
        </View>
      )}
      {reminder === null ? null : (
        <Pressable
          testID="vendor-pan-banner"
          accessibilityRole="button"
          className="bg-amber-100 px-4 py-3 active:bg-amber-200"
          onPress={() => {
            router.push('/settings');
          }}
        >
          <Text className="text-sm font-semibold text-amber-900">
            {t(`vendorShop.${reminder}`)}
          </Text>
        </Pressable>
      )}
      {live === undefined && query.isError ? (
        <View className="bg-amber-50 px-4 py-2" testID="vendor-live-unavailable">
          <Text className="text-sm text-amber-900">{t('vendorDashboard.liveUnavailable')}</Text>
        </View>
      ) : null}

      <OrderStageTabs
        selected={stage}
        counts={counts}
        unanswered={unanswered}
        onSelect={setStage}
      />

      <FlatList
        testID="vendor-order-list"
        className="flex-1"
        contentContainerStyle={{ padding: 16, gap: 12 }}
        data={board[stage]}
        keyExtractor={keyOf}
        renderItem={renderItem}
        keyboardShouldPersistTaps="handled"
        // The screen stays open all day: mount a screenful, keep a small window, drop the rest.
        initialNumToRender={6}
        maxToRenderPerBatch={6}
        windowSize={5}
        removeClippedSubviews={Platform.OS === 'android'}
        ListEmptyComponent={
          total === 0 ? (
            <Text className="text-center text-base text-gray-500" testID="vendor-orders-empty">
              {t('vendorDashboard.empty')}
            </Text>
          ) : (
            <Text className="text-center text-base text-gray-500" testID="vendor-stage-empty">
              {t('vendorDashboard.stageEmpty')}
            </Text>
          )
        }
        refreshControl={
          <RefreshControl refreshing={query.isRefetching} onRefresh={() => void query.refetch()} />
        }
      />
    </View>
  );
}
