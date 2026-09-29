/** Integration tests against the local Kafka broker (pnpm infra:up). */
/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  testMatch: ['**/*.int.test.ts'],
  globalSetup: '<rootDir>/test/global-setup.ts',
  testTimeout: 60000,
};
