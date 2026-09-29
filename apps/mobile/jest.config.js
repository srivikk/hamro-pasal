const expoPreset = require('jest-expo/jest-preset');

// jest-expo skips transforming node_modules except React Native packages. msw (used by the API
// tests) depends on ES-module-only packages, so those are transformed too: every `.mjs` file
// (the trailing lookahead) plus the packages below, which ship ESM as `.js` ("type": "module").
const ESM_JS_PACKAGES = ['until-async'];

const [nodeModulesPattern, ...otherIgnorePatterns] = expoPreset.transformIgnorePatterns;
const ALLOWLIST_START = '/node_modules/(?!(';
if (typeof nodeModulesPattern !== 'string' || !nodeModulesPattern.startsWith(ALLOWLIST_START)) {
  throw new Error(
    'jest-expo changed its transformIgnorePatterns; update apps/mobile/jest.config.js',
  );
}
const allowlisted = nodeModulesPattern.replace(
  ALLOWLIST_START,
  `${ALLOWLIST_START}${ESM_JS_PACKAGES.join('|')}|`,
);

/** @type {import('jest').Config} */
module.exports = {
  preset: 'jest-expo',
  setupFiles: ['<rootDir>/jest.setup.ts'],
  setupFilesAfterEnv: ['<rootDir>/jest.setup-after-env.ts'],
  testTimeout: 15000,
  // msw/node maps the `react-native` export condition (which jest-expo resolves with) to null, so
  // point it at the build Node itself resolves.
  moduleNameMapper: { '^msw/node$': require.resolve('msw/node') },
  // Merged with jest-expo's transforms, which do not cover `.mjs`.
  transform: { '^.+\\.mjs$': 'babel-jest' },
  transformIgnorePatterns: [`${allowlisted}(?!.*\\.mjs$)`, ...otherIgnorePatterns],
};
