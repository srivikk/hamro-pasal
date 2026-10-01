/**
 * Unit tests of the dashboard's logic (API client, session, formatting, action rules). The app is
 * ESM for Vite; ts-jest transpiles each file to CommonJS for Jest 29 (type checking is `tsc`).
 */
/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  transform: {
    '^.+[.]tsx?$': [
      'ts-jest',
      {
        tsconfig: {
          module: 'commonjs',
          jsx: 'react-jsx',
          isolatedModules: true,
          verbatimModuleSyntax: false,
        },
      },
    ],
  },
};
