/**
 * Shared Vitest settings. Workspace packages expose an `@cbi/source` export
 * condition pointing at their TypeScript sources, so tests and dev servers run
 * against source without a prior build. Production builds resolve `dist/`.
 */
export const SOURCE_CONDITION = '@cbi/source';

const serverConditions = [SOURCE_CONDITION, 'module', 'node', 'development|production'];

export const nodeTestConfig = {
  resolve: { conditions: serverConditions },
  ssr: { resolve: { conditions: serverConditions } },
  test: {
    environment: 'node' as const,
    include: ['src/**/*.test.ts'],
    exclude: ['src/**/*.integration.test.ts'],
  },
};

export const nodeIntegrationTestConfig = {
  ...nodeTestConfig,
  test: {
    environment: 'node' as const,
    include: ['src/**/*.integration.test.ts'],
    testTimeout: 30000,
    hookTimeout: 30000,
  },
};
