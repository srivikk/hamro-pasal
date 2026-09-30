import { act } from '@testing-library/react-native';

type Handler = (...args: unknown[]) => void;

interface Emitted {
  event: string;
  payload: unknown;
  ack: ((error: Error | null, response?: unknown) => void) | null;
}

/**
 * In-memory stand-in for a Socket.io client socket: records what the app emits and lets a test
 * play the server (connect, disconnect, push events, acknowledge or time out emits).
 */
type AuthCallback = (callback: (data: object) => void) => void;

export class FakeSocket {
  readonly emitted: Emitted[] = [];
  connected = false;
  /** The URL the app asked the factory for (set by `created`). */
  url: string | null = null;
  /** Every handshake `auth` payload the app sent, in order. */
  readonly handshakes: unknown[] = [];
  /** Server side: which handshake tokens are accepted (refused ones get UNAUTHENTICATED). */
  acceptToken: (token: unknown) => boolean = () => true;
  /** How many times the app called `connect()`. */
  connectCalls = 0;
  private auth: AuthCallback | null = null;
  private readonly handlers = new Map<string, Set<Handler>>();

  /**
   * Records what a socket factory was called with. With an `auth` callback, `connect()` performs
   * the handshake like Socket.io: it calls `auth`, then accepts or refuses the token it receives.
   */
  created(url: string, options: { auth?: unknown }): this {
    this.url = url;
    if (typeof options.auth === 'function') this.auth = options.auth as AuthCallback;
    return this;
  }

  on(event: string, handler: Handler): this {
    const set = this.handlers.get(event) ?? new Set<Handler>();
    set.add(handler);
    this.handlers.set(event, set);
    return this;
  }

  off(event: string, handler: Handler): this {
    this.handlers.get(event)?.delete(handler);
    return this;
  }

  connect(): this {
    this.connectCalls += 1;
    if (this.auth === null) {
      this.connected = true;
      this.fire('connect');
      return this;
    }
    this.auth((data) => {
      this.handshakes.push(data);
      const token: unknown = Reflect.get(data, 'token');
      act(() => {
        if (this.acceptToken(token)) {
          this.connected = true;
          this.fire('connect');
        } else {
          const error = Object.assign(new Error('UNAUTHENTICATED'), {
            data: { code: 'UNAUTHENTICATED', message: 'Invalid or expired access token' },
          });
          this.fire('connect_error', error);
        }
      });
    });
    return this;
  }

  disconnect(): this {
    this.connected = false;
    return this;
  }

  emit(event: string, payload: unknown): this {
    this.emitted.push({ event, payload, ack: null });
    return this;
  }

  timeout(_ms: number) {
    return {
      emit: (event: string, payload: unknown, ack: Emitted['ack']) => {
        this.emitted.push({ event, payload, ack });
      },
    };
  }

  /** Server side: deliver an event to the app's handlers. */
  serverSend(event: string, ...args: unknown[]): void {
    act(() => {
      this.fire(event, ...args);
    });
  }

  /** Server side: drop the connection (the app should show it is reconnecting). */
  drop(): void {
    this.connected = false;
    act(() => {
      this.fire('disconnect', 'transport close');
    });
  }

  reconnect(): void {
    act(() => {
      this.connect();
    });
  }

  /** Acknowledge (or fail) the most recent emit of `event`. */
  acknowledgeLast(event: string, error: Error | null = null): void {
    const last = [...this.emitted].reverse().find((entry) => entry.event === event);
    act(() => {
      last?.ack?.(error, error === null ? { ok: true } : undefined);
    });
  }

  /** Answer the most recent emit of `event` with `response` (or fail it with `error`). */
  answerLast(event: string, response: unknown, error: Error | null = null): void {
    const last = [...this.emitted].reverse().find((entry) => entry.event === event);
    act(() => {
      last?.ack?.(error, response);
    });
  }

  emittedOf(event: string): unknown[] {
    return this.emitted.filter((entry) => entry.event === event).map((entry) => entry.payload);
  }

  private fire(event: string, ...args: unknown[]): void {
    for (const handler of this.handlers.get(event) ?? []) handler(...args);
  }
}
