import react from '@vitejs/plugin-react';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultClientConditions, type Plugin, type UserConfig } from 'vite';
import {
  collectIconNames,
  subsetBootstrapIconsCss,
} from './packages/design-system/src/build/bootstrap-icons-subset.ts';
import { SOURCE_CONDITION } from './vitest.shared.ts';

const repoRoot = fileURLToPath(new URL('.', import.meta.url));

/**
 * Production builds ship only the Bootstrap Icons rules referenced in the app's
 * own sources and the shared packages (dev keeps the full sheet). The icon font
 * itself stays a separate, cached asset that the browser fetches on first use.
 */
function bootstrapIconsSubset(appRoot: string): Plugin {
  const sourceDirs = [
    join(appRoot, 'src'),
    ...readdirSync(join(repoRoot, 'packages')).map((pkg) => join(repoRoot, 'packages', pkg, 'src')),
  ];
  return {
    name: 'cbi:bootstrap-icons-subset',
    apply: 'build',
    enforce: 'pre',
    transform(code, id) {
      if (!/bootstrap-icons[\\/]font[\\/]bootstrap-icons(\.min)?\.css/.test(id)) return null;
      const used = new Set<string>();
      for (const dir of sourceDirs) {
        let files: string[];
        try {
          files = readdirSync(dir, { recursive: true, encoding: 'utf8' });
        } catch {
          continue; // Package without a src folder.
        }
        for (const file of files) {
          if (/\.(tsx?|scss)$/.test(file) && !/\.test\.tsx?$/.test(file)) {
            collectIconNames(readFileSync(join(dir, file), 'utf8'), used);
          }
        }
      }
      return { code: subsetBootstrapIconsCss(code, used), map: null };
    },
  };
}

/**
 * Shared Vite/Vitest settings for the React apps.
 * - Resolves workspace packages from TypeScript source (`@cbi/source`).
 * - Bootstrap 5.3 SCSS still uses @import and legacy colour functions;
 *   those deprecation warnings are silenced until Bootstrap migrates.
 */
export function webConfig(opts: { port: number; plugins?: Plugin[] }): UserConfig & {
  test: object;
} {
  return {
    plugins: [react(), bootstrapIconsSubset(process.cwd()), ...(opts.plugins ?? [])],
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
      testTimeout: 40_000,
      // Same allowance for expect.poll (its 1 s default is too short under the full parallel run).
      expect: { poll: { timeout: 15_000 } },
    },
  };
}
