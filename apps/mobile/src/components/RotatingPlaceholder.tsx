import { useEffect, useState } from 'react';
import { Animated, Text, View } from 'react-native';

/** How long one phrase stays before the next takes its place. */
export const PLACEHOLDER_ROTATION_MS = 2000;
const FADE_MS = 250;

/**
 * A search field's placeholder that cycles through `phrases`, fading one out and the next in.
 * Drawn over the (empty) input instead of using its native placeholder, which cannot animate.
 * Touches pass through to the input beneath.
 *
 * The clock runs only while `visible` (the field is empty) and there is something to rotate to;
 * it is cleared, and the fade stopped, when that changes or the field unmounts.
 */
export function RotatingPlaceholder({
  phrases,
  visible,
  testID,
  intervalMs = PLACEHOLDER_ROTATION_MS,
}: {
  /** At least one phrase, already translated. One alone is shown without a clock. */
  phrases: readonly string[];
  /** False while the field has text: nothing is drawn and nothing ticks. */
  visible: boolean;
  testID?: string;
  intervalMs?: number;
}) {
  const [step, setStep] = useState(0);
  const [opacity] = useState(() => new Animated.Value(1));
  const count = phrases.length;

  useEffect(() => {
    if (!visible || count < 2) return undefined;
    const timer = setInterval(() => {
      Animated.timing(opacity, { toValue: 0, duration: FADE_MS, useNativeDriver: true }).start(
        ({ finished }) => {
          // A stopped fade (unmount, or the customer started typing) must not touch state.
          if (!finished) return;
          setStep((current) => current + 1);
          Animated.timing(opacity, {
            toValue: 1,
            duration: FADE_MS,
            useNativeDriver: true,
          }).start();
        },
      );
    }, intervalMs);
    return () => {
      clearInterval(timer);
      opacity.stopAnimation();
      opacity.setValue(1);
    };
  }, [visible, count, intervalMs, opacity]);

  if (!visible || count === 0) return null;
  return (
    <View pointerEvents="none" className="absolute bottom-0 left-2 right-2 top-0 justify-center">
      <Animated.View style={{ opacity }}>
        <Text className="text-base text-gray-400" numberOfLines={1} testID={testID}>
          {phrases[step % count]}
        </Text>
      </Animated.View>
    </View>
  );
}
