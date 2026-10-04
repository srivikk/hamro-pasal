import { mockServicesEnabled, type PushAudience, type ServerEnv } from '@hamro-pasal/shared-types';

import {
  ExpoPushGateway,
  type ExpoPushMessage,
  type PushGateway,
  type PushTicket,
} from './expo-push';

/** MOCK_SERVICES: accepts every message without a request to exp.host. */
export class MockPushGateway implements PushGateway {
  readonly sent: ExpoPushMessage[] = [];

  send(messages: readonly ExpoPushMessage[]): Promise<PushTicket[]> {
    const first = this.sent.length + 1;
    this.sent.push(...messages);
    return Promise.resolve(
      messages.map((message, index): PushTicket => ({
        token: message.to,
        status: 'ok',
        id: `mock-${String(first + index)}`,
      })),
    );
  }
}

/** `[MOCK PUSH] -> Vendor <vendor id>: <payload>` or `[MOCK PUSH] -> User <customer id>: <payload>`. */
export function mockPushLogLine(
  audience: PushAudience,
  recipientId: string,
  payload: Omit<ExpoPushMessage, 'to'>,
): string {
  const recipient = audience === 'VENDOR' ? 'Vendor' : 'User';
  return `[MOCK PUSH] -> ${recipient} ${recipientId}: ${JSON.stringify(payload)}`;
}

/** The Expo push service, or the mock while MOCK_SERVICES is on (never in production). */
export function pushGatewayFromEnv(
  env: Pick<ServerEnv, 'MOCK_SERVICES' | 'NODE_ENV' | 'EXPO_ACCESS_TOKEN'>,
): PushGateway {
  if (mockServicesEnabled(env)) return new MockPushGateway();
  return new ExpoPushGateway(
    env.EXPO_ACCESS_TOKEN === undefined ? {} : { accessToken: env.EXPO_ACCESS_TOKEN },
  );
}

/** Where the `[MOCK PUSH]` lines go (default: console.info); null unless MOCK_SERVICES is on. */
export function mockPushLogFromEnv(
  env: Pick<ServerEnv, 'MOCK_SERVICES' | 'NODE_ENV'>,
  log: (line: string) => void = (line) => {
    console.info(line);
  },
): ((line: string) => void) | null {
  return mockServicesEnabled(env) ? log : null;
}
