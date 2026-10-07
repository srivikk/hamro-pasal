/** What the tab navigator knows about one of its tabs, as far as a reset needs. */
interface TabRoute {
  name: string;
  /** The tab's own stack, once something has been rendered in it. */
  state?: { key?: string; index?: number } | undefined;
}

export interface TabsState {
  index: number;
  routes: readonly TabRoute[];
}

export interface PopToTopAction {
  type: 'POP_TO_TOP';
  /** The key of the stack to pop: only that stack reacts. */
  target: string;
}

/**
 * Pressing a tab that is already on screen while its stack is deeper than its first screen (a
 * shop's page inside the Shops tab) must return to that first screen. This gives the action that
 * does it, or null when there is nothing to pop: the pressed tab is not the current one (then the
 * navigator just switches to it, keeping where the customer was), or its stack is already at
 * its root.
 */
export function tabResetAction(state: TabsState, pressedTab: string): PopToTopAction | null {
  const current = state.routes[state.index];
  if (current?.name !== pressedTab) return null;
  const stack = current.state;
  if (stack?.key === undefined || (stack.index ?? 0) === 0) return null;
  return { type: 'POP_TO_TOP', target: stack.key };
}

/** The part of the tab navigator the reset uses (Expo Router hands it to `listeners` untyped). */
export interface TabsNavigation {
  getState: () => TabsState;
  dispatch: (action: PopToTopAction) => void;
}
