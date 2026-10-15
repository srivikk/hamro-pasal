import { alertResponseSchema, type VendorMenu } from '@hamro-pasal/shared-types';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';

import { ApiError, apiRequest } from '../../api/http';
import { selectHasSession, useAuthStore } from '../../store/useAuthStore';
import { useToastStore } from '../../store/useToastStore';

/** What a Notify Me tap is about: one product of the menu, or the shop itself. */
export type NotifyMeTarget =
  | { readonly kind: 'product'; readonly id: string }
  | { readonly kind: 'shop'; readonly id: string };

export function alertPath(target: NotifyMeTarget): string {
  return `/api/me/alerts/${target.kind === 'product' ? 'products' : 'shops'}/${target.id}`;
}

/** PUT (ask to be told) or DELETE (withdraw) a Notify Me request. */
export function saveAlert(target: NotifyMeTarget, alerted: boolean) {
  return apiRequest({
    method: alerted ? 'PUT' : 'DELETE',
    path: alertPath(target),
    schema: alertResponseSchema,
  });
}

function withAlert(menu: VendorMenu, target: NotifyMeTarget, alerted: boolean): VendorMenu {
  return target.kind === 'shop'
    ? { ...menu, is_alerted: alerted }
    : {
        ...menu,
        products: menu.products.map((product) =>
          product.id === target.id ? { ...product, is_alerted: alerted } : product,
        ),
      };
}

/**
 * Step 7.4 (SPEC core 11, Notify Me): toggles a request from the shop page and keeps the cached
 * menu (`queryKey`) in step with the server's answer. A guest is asked to sign in first.
 */
export function useNotifyMe(menuQueryKey: readonly unknown[]) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const signedIn = useAuthStore(selectHasSession);
  const showToast = useToastStore((state) => state.show);
  const save = useMutation({
    mutationFn: ({ target, alerted }: { target: NotifyMeTarget; alerted: boolean }) =>
      saveAlert(target, alerted),
    retry: false,
    onSuccess: (result, { target }) => {
      queryClient.setQueryData<VendorMenu>(menuQueryKey, (menu) =>
        menu === undefined ? menu : withAlert(menu, target, result.alerted),
      );
      showToast(t(result.alerted ? 'notifyMe.added' : 'notifyMe.removed'), 'info');
    },
    onError: (error) => {
      const code = error instanceof ApiError ? error.code : null;
      showToast(
        t(
          code === 'ALERT_LIMIT_REACHED'
            ? 'notifyMe.limit'
            : code === 'ALREADY_AVAILABLE'
              ? 'notifyMe.alreadyAvailable'
              : 'notifyMe.failed',
        ),
        'error',
      );
      // Already available: the menu on screen is out of date.
      if (code === 'ALREADY_AVAILABLE')
        void queryClient.invalidateQueries({ queryKey: menuQueryKey });
    },
  });

  return {
    pending: save.isPending,
    toggle(target: NotifyMeTarget, alerted: boolean) {
      if (!signedIn) {
        showToast(t('notifyMe.signIn'), 'info');
        return;
      }
      save.mutate({ target, alerted: !alerted });
    },
  };
}
