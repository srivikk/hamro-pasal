import { Pressable, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { BOARD_STAGES, type BoardStage } from './order-board';

interface OrderStageTabsProps {
  selected: BoardStage;
  counts: Record<BoardStage, number>;
  /** New orders nobody has answered yet: the New tab's count turns red. */
  unanswered: number;
  onSelect: (stage: BoardStage) => void;
}

/** The board's segmented control: New → Preparing → Ready → Handed Over, each with its count. */
export function OrderStageTabs({ selected, counts, unanswered, onSelect }: OrderStageTabsProps) {
  const { t } = useTranslation();
  return (
    <View className="mt-3 flex-row bg-white" accessibilityRole="tablist">
      {BOARD_STAGES.map((stage) => {
        const active = stage === selected;
        const alert = stage === 'NEW' && unanswered > 0;
        return (
          <Pressable
            key={stage}
            testID={`stage-${stage}`}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            onPress={() => {
              onSelect(stage);
            }}
            className={`flex-1 items-center gap-1 border-b-2 px-1 py-3 ${active ? 'border-brand' : 'border-transparent'}`}
          >
            <Text
              numberOfLines={1}
              className={`font-body-semibold text-sm ${active ? 'text-brand' : 'text-gray-500'}`}
            >
              {t(`vendorDashboard.stage.${stage}`)}
            </Text>
            <Text
              testID={`stage-count-${stage}`}
              className={`min-w-6 rounded-full px-2 py-0.5 text-center text-xs font-bold ${alert ? 'bg-red-600 text-white' : 'bg-gray-100 text-gray-700'}`}
            >
              {t('vendorDashboard.count', { count: counts[stage] })}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}
