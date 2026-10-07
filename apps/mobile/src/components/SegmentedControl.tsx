import { Pressable, Text, View } from 'react-native';

export interface Segment<Value extends string> {
  value: Value;
  label: string;
}

interface SegmentedControlProps<Value extends string> {
  /** Each segment's test id is `<testID>-<value>`. */
  testID: string;
  segments: readonly Segment<Value>[];
  selected: Value;
  onSelect: (value: Value) => void;
}

/** A row of mutually exclusive choices, one of them selected: a screen's sections, or a form's. */
export function SegmentedControl<Value extends string>({
  testID,
  segments,
  selected,
  onSelect,
}: SegmentedControlProps<Value>) {
  return (
    <View className="flex-row rounded-xl bg-gray-200 p-1" accessibilityRole="tablist">
      {segments.map((segment) => {
        const active = segment.value === selected;
        return (
          <Pressable
            key={segment.value}
            testID={`${testID}-${segment.value}`}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            onPress={() => {
              onSelect(segment.value);
            }}
            className={`flex-1 items-center rounded-lg px-2 py-2 ${active ? 'bg-white' : 'bg-transparent'}`}
          >
            <Text
              numberOfLines={1}
              className={`text-sm font-semibold ${active ? 'text-gray-900' : 'text-gray-500'}`}
            >
              {segment.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}
