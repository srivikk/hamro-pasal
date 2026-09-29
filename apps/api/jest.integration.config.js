/**
 * Integration tests against real PostgreSQL + PostGIS and Redis (pnpm infra:up).
 * globalSetup recreates hamro_pasal_api_test and flushes Redis logical DB 15.
 */
/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  testMatch: ['**/*.int.test.ts'],
  globalSetup: '<rootDir>/test/global-setup.ts',
  testTimeout: 60000,
};
