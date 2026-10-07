import type { OrderView } from '@hamro-pasal/shared-types';
import { Text } from 'react-native';
import { useTranslation } from 'react-i18next';

/** What the person at the door collects: the COD total, or nothing for a prepaid order. */
export function CashToCollect({ order }: { order: OrderView }) {
  const { t } = useTranslation();
  const cod = order.payment_method === 'COD' && order.payment_status !== 'PAID';
  return (
    <Text
      className={`text-base font-semibold ${cod ? 'text-red-700' : 'text-gray-700'}`}
      testID={`delivery-cash-${order.id}`}
    >
      {cod ? t('delivery.collectCash', { amount: order.total_npr }) : t('delivery.prepaid')}
    </Text>
  );
}
