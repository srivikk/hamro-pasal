import { parseApiUrl } from './parse-api-url';

export { ApiConfigError } from './parse-api-url';

/**
 * API base URL, validated when this module is first evaluated, so a missing or malformed
 * EXPO_PUBLIC_API_URL stops the app at startup instead of surfacing as a failed request.
 *
 * Expo inlines EXPO_PUBLIC_* at build time only for this literal `process.env.X` access form.
 */
export const API_URL: string = parseApiUrl(process.env.EXPO_PUBLIC_API_URL);
