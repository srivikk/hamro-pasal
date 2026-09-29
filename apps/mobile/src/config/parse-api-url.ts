/** `http(s)://host[:port][/path]` with nothing after the path. The host may be a LAN IP or a DNS name. */
const API_URL_PATTERN = /^https?:\/\/[^\s/?#:]+(?::\d{1,5})?(?:\/[^\s?#]*)?$/;

export class ApiConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApiConfigError';
  }
}

/**
 * Validates the API base URL and normalises it (no trailing slash). React Native ships only a
 * partial `URL` implementation, so validation uses a pattern rather than `new URL()`.
 */
export function parseApiUrl(raw: string | undefined): string {
  const value = raw?.trim() ?? '';
  if (value === '') {
    throw new ApiConfigError(
      'EXPO_PUBLIC_API_URL is not set. Create apps/mobile/.env with ' +
        'EXPO_PUBLIC_API_URL=http://<your-computer-LAN-IP>:4000 and restart Metro with `expo start --clear`. ' +
        'A phone or emulator cannot reach the development machine through 127.0.0.1.',
    );
  }
  if (!API_URL_PATTERN.test(value)) {
    throw new ApiConfigError(
      `EXPO_PUBLIC_API_URL must be an absolute http(s) URL with no query or fragment, ` +
        `for example http://192.168.1.20:4000. Received: "${value}".`,
    );
  }
  return value.replace(/\/+$/, '');
}
