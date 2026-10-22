import { Stack, useLocalSearchParams } from 'expo-router';
import { useTranslation } from 'react-i18next';

import { ClosedNotice, DisputeChat } from '../../../src/features/dispute/DisputeChat';
import {
  conversationDeadline,
  isConversationOpen,
} from '../../../src/features/dispute/dispute-window';
import { useBeforeDeadline } from '../../../src/lib/useBeforeDeadline';
import { useOrderStore } from '../../../src/store/useOrderStore';

/**
 * Step 7.3 (SPEC core 6): the conversation with the shop, open from placement until 7 days after
 * delivery (and while escalated).
 */
export default function DisputeScreen() {
  const { t } = useTranslation();
  const { id } = useLocalSearchParams<{ id: string }>();
  const order = useOrderStore((state) => state.orders[id]);
  const beforeEnd = useBeforeDeadline(conversationDeadline(order?.deliveredAt ?? null));
  const eligible =
    order !== undefined && isConversationOpen(order.state, order.deliveredAt, beforeEnd);

  return (
    <>
      <Stack.Screen
        options={{
          headerShown: true,
          title: t('dispute.title'),
          headerBackTitle: t('common.back'),
        }}
      />
      {eligible ? (
        <DisputeChat orderId={id} escalated={order.state === 'DISPUTED'} />
      ) : (
        <ClosedNotice message={t('dispute.closed')} />
      )}
    </>
  );
}
