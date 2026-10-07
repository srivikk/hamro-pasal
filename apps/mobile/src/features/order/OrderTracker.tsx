import Ionicons from '@expo/vector-icons/Ionicons';
import type { OrderState } from '@hamro-pasal/shared-types';
import { Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { colors } from '../../theme/colors';
import { trackerNodes, type StepStatus } from './order-tracker';

const ICON: Record<StepStatus, 'checkmark-circle' | 'radio-button-on' | 'ellipse-outline'> = {
  completed: 'checkmark-circle',
  active: 'radio-button-on',
  pending: 'ellipse-outline',
};

const ICON_COLOR: Record<StepStatus, string> = {
  completed: colors.success,
  active: colors.brand,
  pending: colors.inactive,
};

const LABEL_CLASS: Record<StepStatus, string> = {
  completed: 'text-gray-900',
  active: 'font-bold text-brand',
  pending: 'text-gray-400',
};

/**
 * SPEC journey step 9: discrete state nodes (no live map). Renders nothing for states the
 * tracker does not show (cancelled, failed, still in checkout).
 */
export function OrderTracker({ state }: { state: OrderState }) {
  const { t } = useTranslation();
  const nodes = trackerNodes(state);
  if (nodes === null) return null;

  return (
    <View className="rounded-2xl bg-white p-4" testID="order-tracker">
      {nodes.map(({ step, status }, index) => {
        const label = t(`order.steps.${step}`);
        const last = index === nodes.length - 1;
        return (
          <View
            key={step}
            testID={`tracker-step-${step}`}
            accessibilityLabel={t(`order.stepStatus.${status}`, { step: label })}
            accessibilityState={{ selected: status === 'active', disabled: status === 'pending' }}
            className="flex-row"
          >
            <View className="mr-3 items-center">
              <Ionicons name={ICON[status]} size={24} color={ICON_COLOR[status]} />
              {last ? null : (
                <View
                  className={`my-1 w-0.5 flex-1 ${status === 'completed' ? 'bg-emerald-600' : 'bg-gray-200'}`}
                  style={{ minHeight: 20 }}
                />
              )}
            </View>
            <Text className={`pt-0.5 text-base ${LABEL_CLASS[status]}`}>{label}</Text>
          </View>
        );
      })}
    </View>
  );
}
