import react from '@vitejs/plugin-react';
import { defaultClientConditions, type UserConfig } from 'vite';
import { SOURCE_CONDITION } from './vitest.shared.ts';

/**
 * Shared Vite/Vitest settings for the React apps.
 * - Resolves workspace packages from TypeScript source (`@cbi/source`).
 * - Bootstrap 5.3 SCSS still uses @import and legacy colour functions;
 *   those deprecation warnings are silenced until Bootstrap migrates.
 */
export function webConfig(opts: { port: number }): UserConfig & { test: object } {
  return {
    plugins: [react()],
    // Read VITE_* variables from the monorepo root .env; other variables are never exposed.
    envDir: '../..',
    resolve: { conditions: [SOURCE_CONDITION, ...defaultClientConditions] },
    css: {
      preprocessorOptions: {
        scss: {
          quietDeps: true,
          silenceDeprecations: ['import', 'global-builtin', 'color-functions', 'if-function'],
        },
      },
    },
    server: { port: opts.port, strictPort: true },
    preview: { port: opts.port + 1000, strictPort: true },
    build: { target: 'es2022', sourcemap: true },
    test: {
      environment: 'jsdom',
      include: ['src/**/*.test.{ts,tsx}'],
      setupFiles: ['./src/test/setup.ts'],
      css: false,
      // Form tests type into many fields; turbo runs every suite at once, so allow for a loaded machine.
      testTimeout: 20_000,
    },
  };
}
