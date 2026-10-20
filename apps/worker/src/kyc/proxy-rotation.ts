/*
 * IRD_PROXY_URLS (decided by the user 2026-10-21): when set, each lookup attempt goes out through
 * the next proxy in the list, in turn, so a retry after a timeout or a refused CAPTCHA leaves from
 * another address. With the list empty, the worker's own address is used.
 */

/** The shape Playwright takes for a browser context's proxy. */
export interface BrowserProxy {
  readonly server: string;
  readonly username?: string;
  readonly password?: string;
}

/** `http://user:pass@host:8080` → server without the credentials, and the credentials apart. */
export function toBrowserProxy(url: string): BrowserProxy {
  const parsed = new URL(url);
  const server = `${parsed.protocol}//${parsed.host}`;
  if (parsed.username === '') return { server };
  return {
    server,
    username: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
  };
}

export class ProxyRotation {
  private readonly proxies: readonly BrowserProxy[];
  private cursor = 0;

  constructor(urls: readonly string[]) {
    this.proxies = urls.map(toBrowserProxy);
  }

  /** The next proxy, round robin; undefined when none is configured. */
  next(): BrowserProxy | undefined {
    if (this.proxies.length === 0) return undefined;
    const proxy = this.proxies[this.cursor % this.proxies.length];
    this.cursor += 1;
    return proxy;
  }

  get size(): number {
    return this.proxies.length;
  }
}

/** For logs: where an attempt went out, never with its credentials. */
export function describeProxy(proxy: BrowserProxy | undefined): string {
  return proxy === undefined ? 'direct' : proxy.server;
}
