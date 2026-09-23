/**
 * Shared Vitest settings. Workspace packages expose an `@cbi/source` export
 * condition pointing at their TypeScript sources, so tests and dev servers run
 * against source without a prior build. Production builds resolve `dist/`.
 */
export const SOURCE_CONDITION = '@cbi/source';

// No 'module' condition: it selects bundler-only builds (e.g. AWS SDK dist-es) that Node cannot load.
const serverConditions = [SOURCE_CONDITION, 'node', 'development|production'];

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
    // Suites share one database and wipe it between tests; run files one at a time.
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 30000,
  },
};
