import { act } from '@testing-library/react-native';
import { View } from 'react-native';
import type { WebViewNavigation, WebViewProps } from 'react-native-webview';

/*
 * Stand-in for react-native-webview (a native view that cannot run under Jest). It renders a
 * plain View and records the props of the latest render, so tests can inspect `source` and drive
 * `onNavigationStateChange` as the real WebView would.
 *
 * Registered for every test file in jest.setup.ts.
 */

export const mockWebView: { props: WebViewProps | null; renders: number } = {
  props: null,
  renders: 0,
};

function recordRender(props: WebViewProps): void {
  mockWebView.props = props;
  mockWebView.renders += 1;
}

export function WebView(props: WebViewProps) {
  // Test double: recording during render is the point (tests read the latest props).
  recordRender(props);
  return <View testID={props.testID ?? 'webview'} />;
}

export default WebView;

export function resetMockWebView(): void {
  mockWebView.props = null;
  mockWebView.renders = 0;
}

/** Simulates the WebView reporting a navigation to `url`. */
export function navigateWebView(url: string): void {
  const handler = mockWebView.props?.onNavigationStateChange;
  if (handler === undefined) throw new Error('No WebView with onNavigationStateChange is rendered');
  const event: WebViewNavigation = {
    url,
    loading: false,
    title: '',
    canGoBack: false,
    canGoForward: false,
    lockIdentifier: 0,
    navigationType: 'other',
  };
  act(() => {
    handler(event);
  });
}

/** Simulates the page finishing its load (hides the spinner). */
export function finishWebViewLoad(): void {
  const handler = mockWebView.props?.onLoadEnd;
  if (handler === undefined) throw new Error('No WebView with onLoadEnd is rendered');
  act(() => {
    handler({ nativeEvent: {} } as Parameters<typeof handler>[0]);
  });
}
