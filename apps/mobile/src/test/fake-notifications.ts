/*
 * Stand-in for expo-notifications (permissions, tokens, channels and the foreground handler are
 * native). Tests set what the device answers through `mockNotifications` and assert on the
 * recorded calls. Registered for every test file in jest.setup.ts, together with
 * expo-task-manager (`mockTasks`).
 */

interface PermissionAnswer {
  granted: boolean;
  canAskAgain: boolean;
}

interface FakeNotificationHandler {
  handleNotification: (notification: unknown) => Promise<unknown>;
}

export const mockNotifications: {
  /** What getPermissionsAsync answers. */
  permission: PermissionAnswer;
  /** What requestPermissionsAsync answers (the user's choice in the OS prompt). */
  requested: PermissionAnswer;
  /** The Expo push token of this device; null makes getExpoPushTokenAsync reject. */
  pushToken: string | null;
  handler: FakeNotificationHandler | null;
  channels: { id: string; input: unknown }[];
  /** Channel ids passed to deleteNotificationChannelAsync, in order. */
  deletedChannels: string[];
  scheduled: unknown[];
  registeredTasks: string[];
  /** Listeners added with addNotificationResponseReceivedListener (a tap on a notification). */
  responseListeners: ((response: unknown) => void)[];
  /** What getLastNotificationResponseAsync answers (the tap that started the app), or null. */
  lastResponse: unknown;
  /** Listeners added with addNotificationReceivedListener (a push arriving while open). */
  receivedListeners: ((notification: unknown) => void)[];
  /** Every count passed to setBadgeCountAsync, in order. */
  badgeCounts: number[];
} = {
  permission: { granted: false, canAskAgain: true },
  requested: { granted: true, canAskAgain: true },
  pushToken: 'ExponentPushToken[test-device]',
  handler: null,
  channels: [],
  deletedChannels: [],
  scheduled: [],
  registeredTasks: [],
  responseListeners: [],
  lastResponse: null,
  receivedListeners: [],
  badgeCounts: [],
};

export function resetMockNotifications(): void {
  mockNotifications.permission = { granted: false, canAskAgain: true };
  mockNotifications.requested = { granted: true, canAskAgain: true };
  mockNotifications.pushToken = 'ExponentPushToken[test-device]';
  mockNotifications.handler = null;
  mockNotifications.channels = [];
  mockNotifications.deletedChannels = [];
  mockNotifications.scheduled = [];
  mockNotifications.registeredTasks = [];
  mockNotifications.responseListeners = [];
  mockNotifications.lastResponse = null;
  mockNotifications.receivedListeners = [];
  mockNotifications.badgeCounts = [];
  for (const mock of [
    getPermissionsAsync,
    requestPermissionsAsync,
    getExpoPushTokenAsync,
    scheduleNotificationAsync,
  ]) {
    mock.mockClear();
  }
}

export function addNotificationResponseReceivedListener(listener: (response: unknown) => void): {
  remove: () => void;
} {
  mockNotifications.responseListeners.push(listener);
  return {
    remove: () => {
      mockNotifications.responseListeners = mockNotifications.responseListeners.filter(
        (registered) => registered !== listener,
      );
    },
  };
}

export function addNotificationReceivedListener(listener: (notification: unknown) => void): {
  remove: () => void;
} {
  mockNotifications.receivedListeners.push(listener);
  return {
    remove: () => {
      mockNotifications.receivedListeners = mockNotifications.receivedListeners.filter(
        (registered) => registered !== listener,
      );
    },
  };
}

export function setBadgeCountAsync(count: number): Promise<boolean> {
  mockNotifications.badgeCounts.push(count);
  return Promise.resolve(true);
}

export function getLastNotificationResponse(): unknown {
  return mockNotifications.lastResponse;
}

export const AndroidImportance = { DEFAULT: 5, HIGH: 6, MAX: 7 } as const;
export const AndroidNotificationVisibility = {
  UNKNOWN: 0,
  PUBLIC: 1,
  PRIVATE: 2,
  SECRET: 3,
} as const;
export const AndroidAudioUsage = { NOTIFICATION: 5, ALARM: 4 } as const;
export const AndroidAudioContentType = { UNKNOWN: 0, SONIFICATION: 4 } as const;
export const AndroidNotificationPriority = {
  DEFAULT: 'default',
  HIGH: 'high',
  MAX: 'max',
} as const;

export const BackgroundNotificationTaskResult = { NewData: 0, NoData: 1, Failed: 2 } as const;

export const getPermissionsAsync = jest.fn(() => Promise.resolve(mockNotifications.permission));

export const requestPermissionsAsync = jest.fn(() => {
  mockNotifications.permission = mockNotifications.requested;
  return Promise.resolve(mockNotifications.requested);
});

export const getExpoPushTokenAsync = jest.fn((_options?: { projectId?: string }) =>
  mockNotifications.pushToken === null
    ? Promise.reject(new Error('push tokens are unavailable on this device'))
    : Promise.resolve({ type: 'expo' as const, data: mockNotifications.pushToken }),
);

export function setNotificationHandler(handler: FakeNotificationHandler | null): void {
  mockNotifications.handler = handler;
}

export function setNotificationChannelAsync(id: string, input: unknown): Promise<null> {
  mockNotifications.channels.push({ id, input });
  return Promise.resolve(null);
}

export function deleteNotificationChannelAsync(id: string): Promise<void> {
  mockNotifications.deletedChannels.push(id);
  return Promise.resolve();
}

export const scheduleNotificationAsync = jest.fn((request: unknown) => {
  mockNotifications.scheduled.push(request);
  return Promise.resolve('scheduled-notification');
});

export function registerTaskAsync(taskName: string): Promise<null> {
  mockNotifications.registeredTasks.push(taskName);
  return Promise.resolve(null);
}

/* ---------- expo-task-manager ---------- */

type TaskExecutor = (body: { data: unknown; error: null }) => Promise<unknown>;

export const mockTasks = new Map<string, TaskExecutor>();

export function defineTask(taskName: string, executor: TaskExecutor): void {
  mockTasks.set(taskName, executor);
}

export function isTaskDefined(taskName: string): boolean {
  return mockTasks.has(taskName);
}
