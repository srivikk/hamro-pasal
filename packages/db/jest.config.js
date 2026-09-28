/** Unit tests only. Database-backed tests live in test/ and run via `test:integration`. */
/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
};
