import type { DriverDeliverResponseBody, DriverOrderView } from '@hamro-pasal/shared-types';
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';

import {
  DELIVERY_ERROR_CODES,
  deliverDriverOrder,
  fetchDriverOrders,
} from '../../api/driver-orders';
import { ApiError } from '../../api/http';
import { retryTransientFailures } from '../../api/query-client';
import { useToastStore } from '../../store/useToastStore';
import { lockoutMinutes } from './delivery-otp-input';

export const driverOrdersQueryKey = ['driver', 'orders'] as const;

/** The rider's orders out for delivery (GET /api/driver/orders). */
export function useDriverOrdersQuery() {
  return useQuery({
    queryKey: driverOrdersQueryKey,
    queryFn: fetchDriverOrders,
    retry: retryTransientFailures,
    // Always ask again on mount: a new gig may have been dispatched since.
    staleTime: 0,
  });
}

export interface DeliverInput {
  readonly orderId: string;
  readonly otp: string;
}

const attemptsDetailsSchema = z.object({ attempts_remaining: z.number().int().nonnegative() });
const lockoutDetailsSchema = z.object({ retry_after_seconds: z.number().int().positive() });

/** Drops a handed-over (or no longer deliverable) order from the cached list. */
function removeOrder(queryClient: QueryClient, orderId: string): void {
  queryClient.setQueryData<DriverOrderView[]>(driverOrdersQueryKey, (orders) =>
    orders?.filter((order) => order.id !== orderId),
  );
}

/**
 * Confirms a handoff with the customer's code (driver flow step 5). Success removes the order
 * from the list at once; a wrong code or a lockout keeps it and says why; an order that moved on
 * (delivered elsewhere, taken by another rider) is removed. Never retried automatically: every
 * retry of a wrong code would count as another attempt.
 */
export function useDeliverOrder() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const toast = useToastStore((store) => store.show);

  const mutation = useMutation<DriverDeliverResponseBody, unknown, DeliverInput>({
    mutationKey: ['driver', 'deliver'],
    mutationFn: ({ orderId, otp }) => deliverDriverOrder(orderId, otp),
    retry: false,
    onSuccess: (result) => {
      removeOrder(queryClient, result.order_id);
      toast(t('driverDashboard.delivered'), 'success');
    },
    onError: (error, { orderId }) => {
      toast(deliveryErrorMessage(error, t), 'error');
      if (
        error instanceof ApiError &&
        (error.code === 'ORDER_STATE_CONFLICT' || error.code === 'ORDER_NOT_FOUND')
      ) {
        removeOrder(queryClient, orderId);
      }
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: driverOrdersQueryKey });
    },
  });

  return {
    deliver: mutation.mutate,
    /** The order whose code is being checked right now, if any. */
    pendingOrderId: mutation.isPending ? mutation.variables.orderId : null,
  };
}

type Translate = ReturnType<typeof useTranslation>['t'];

export function deliveryErrorMessage(error: unknown, t: Translate): string {
  if (!(error instanceof ApiError)) return t('driverDashboard.failed');
  switch (error.code) {
    case DELIVERY_ERROR_CODES.invalidOtp: {
      const details = attemptsDetailsSchema.safeParse(error.details);
      return details.success
        ? t('driverDashboard.wrongCode', { count: details.data.attempts_remaining })
        : t('driverDashboard.wrongCodeNoCount');
    }
    case DELIVERY_ERROR_CODES.locked: {
      const details = lockoutDetailsSchema.safeParse(error.details);
      return t('driverDashboard.locked', {
        minutes: lockoutMinutes(details.success ? details.data.retry_after_seconds : 60),
      });
    }
    case DELIVERY_ERROR_CODES.malformedOtp:
      return t('driverDashboard.incompleteCode');
    case 'ORDER_STATE_CONFLICT':
    case 'ORDER_NOT_FOUND':
      return t('driverDashboard.noLongerYours');
    default:
      return t('driverDashboard.failed');
  }
}
