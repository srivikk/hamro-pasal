import appVersion from './app-version.json';

/**
 * The customer-facing version, shown at the foot of the Profile tab and on About. Kept in JSON so
 * app.config.ts (loaded by Expo without TypeScript module resolution) uses the same value as the
 * stores' version name.
 */
export const APP_VERSION: string = appVersion.version;
