import type { ReactNode } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

/** Height of the iOS navigation bar under the status bar. */
const IOS_NAVIGATION_BAR_HEIGHT = 44;

/**
 * A scrolling form screen whose fields and buttons stay above the keyboard: the content area
 * shrinks by the keyboard's height (padding on iOS, height on Android) and scrolls inside what
 * is left. Taps on buttons work while the keyboard is open.
 */
export function KeyboardScreen({
  children,
  /** The screen sits under a stack header (iOS measures the keyboard from the window's top). */
  hasHeader = true,
  testID,
}: {
  children: ReactNode;
  hasHeader?: boolean;
  testID?: string;
}) {
  const { top } = useSafeAreaInsets();
  return (
    <KeyboardAvoidingView
      testID={testID}
      className="flex-1 bg-gray-50 dark:bg-gray-950"
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      keyboardVerticalOffset={
        Platform.OS === 'ios' && hasHeader ? top + IOS_NAVIGATION_BAR_HEIGHT : 0
      }
    >
      <ScrollView
        contentContainerStyle={{ padding: 24, gap: 16, flexGrow: 1 }}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
      >
        {children}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
