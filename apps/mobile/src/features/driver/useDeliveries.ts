import type { DeliveryConfirmedResponseBody, DeliveryView } from '@hamro-pasal/shared-types';
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';

import {
  advanceDelivery,
  completeDelivery,
  DELIVERY_ROUTE_ERROR_CODES,
  fetchDeliveries,
  type DeliveryStep,
} from '../../api/deliveries';
import { ApiError } from '../../api/http';
import { retryTransientFailures } from '../../api/query-client';
import { useToastStore } from '../../store/useToastStore';
import { deliveryErrorMessage, isStaleDeliveryError } from '../delivery/delivery-errors';

export const deliveriesQueryKey = ['driver', 'deliveries'] as const;

/** Open gigs and the rider's own deliveries (GET /api/deliveries). */
export function useDeliveriesQuery() {
  return useQuery({
    queryKey: deliveriesQueryKey,
    queryFn: fetchDeliveries,
    retry: retryTransientFailures,
    // Always ask again on mount: a new gig may have been dispatched since.
    staleTime: 0,
  });
}

/** Drops a completed (or no longer available) delivery from the cached list. */
function removeDelivery(queryClient: QueryClient, deliveryId: string): void {
  queryClient.setQueryData<DeliveryView[]>(deliveriesQueryKey, (deliveries) =>
    deliveries?.filter((delivery) => delivery.id !== deliveryId),
  );
}

export interface StepInput {
  readonly deliveryId: string;
  readonly step: DeliveryStep;
}

/**
 * Accepts an open gig or marks the parcel picked up (driver flow steps 1 and 2). Success patches
 * the cached delivery with the server's; a gig another rider took, or a delivery that moved on,
 * is removed. Never retried automatically.
 */
export function useDeliveryStep() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const toast = useToastStore((store) => store.show);

  const mutation = useMutation<DeliveryView, unknown, StepInput>({
    mutationKey: ['driver', 'delivery-step'],
    mutationFn: ({ deliveryId, step }) => advanceDelivery(deliveryId, step),
    retry: false,
    onSuccess: (updated, { step }) => {
      queryClient.setQueryData<DeliveryView[]>(deliveriesQueryKey, (deliveries) =>
        deliveries?.map((delivery) => (delivery.id === updated.id ? updated : delivery)),
      );
      toast(
        t(step === 'accept' ? 'driverDashboard.accepted' : 'driverDashboard.pickedUp'),
        'success',
      );
    },
    onError: (error, { deliveryId }) => {
      const code = error instanceof ApiError ? error.code : null;
      if (code === DELIVERY_ROUTE_ERROR_CODES.alreadyAssigned) {
        removeDelivery(queryClient, deliveryId);
        toast(t('driverDashboard.takenByAnother'), 'error');
        return;
      }
      if (isStaleDeliveryError(error)) {
        removeDelivery(queryClient, deliveryId);
        toast(t('delivery.noLongerDeliverable'), 'error');
        return;
      }
      toast(t('driverDashboard.stepFailed'), 'error');
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: deliveriesQueryKey });
    },
  });

  return {
    advance: mutation.mutate,
    /** The delivery whose step is being sent right now, if any. */
    pendingDeliveryId: mutation.isPending ? mutation.variables.deliveryId : null,
  };
}

export interface CompleteInput {
  readonly deliveryId: string;
  readonly otp: string;
}

/**
 * Confirms a handoff with the customer's code (driver flow step 5). Success removes the delivery
 * from the list at once; a wrong code or a lockout keeps it and says why; a delivery that moved
 * on is removed. Never retried automatically: every retry of a wrong code would count as another
 * attempt.
 */
export function useCompleteDelivery() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const toast = useToastStore((store) => store.show);

  const mutation = useMutation<DeliveryConfirmedResponseBody, unknown, CompleteInput>({
    mutationKey: ['driver', 'delivery-complete'],
    mutationFn: ({ deliveryId, otp }) => completeDelivery(deliveryId, otp),
    retry: false,
    onSuccess: (_result, { deliveryId }) => {
      removeDelivery(queryClient, deliveryId);
      toast(t('delivery.delivered'), 'success');
    },
    onError: (error, { deliveryId }) => {
      toast(deliveryErrorMessage(error, t), 'error');
      if (isStaleDeliveryError(error)) removeDelivery(queryClient, deliveryId);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: deliveriesQueryKey });
    },
  });

  return {
    complete: mutation.mutate,
    /** The delivery whose code is being checked right now, if any. */
    pendingDeliveryId: mutation.isPending ? mutation.variables.deliveryId : null,
  };
}
