#!/usr/bin/env node
// Release gate for official brand assets.
//
//   pnpm brand:check            -> exits 1 if any required asset is missing (use before production UI sign-off)
//   pnpm brand:check --report   -> always exits 0; prints the missing list (used in CI as a warning)
//
// Logo paths come from the central registry (packages/design-system/src/brand/brand-assets.ts)
// so this check can never drift from what the apps actually load.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const reportOnly = process.argv.includes('--report');

const registry = readFileSync(
  join(root, 'packages/design-system/src/brand/brand-assets.ts'),
  'utf8',
);
const logoPaths = [...registry.matchAll(/path:\s*'(\/brand\/[^']+)'/g)].map((m) => m[1]);
if (logoPaths.length === 0) {
  console.error('brand-check: no asset paths found in brand-assets.ts; registry format changed?');
  process.exit(1);
}

const apps = ['apps/candidate-web', 'apps/admin-web'];
// Non-logo files every app must ship (docs/product/brand-assets-required.md items 5–6).
const extraFiles = {
  'apps/candidate-web': [['/favicon.ico', '/favicon.svg'], ['/brand/og-image.png']],
  'apps/admin-web': [['/favicon.ico', '/favicon.svg']],
};

const missing = [];
for (const app of apps) {
  const required = [...logoPaths.map((p) => [p]), ...(extraFiles[app] ?? [])];
  for (const alternatives of required) {
    const found = alternatives.some((p) => existsSync(join(root, app, 'public', p)));
    if (!found) missing.push(`${app}/public${alternatives.join(' or ')}`);
  }
}

if (missing.length === 0) {
  console.log('brand-check: all required brand assets are present.');
  process.exit(0);
}

const header = `brand-check: ${missing.length} official brand asset(s) missing — RELEASE BLOCKER for production UI sign-off`;
if (process.env.GITHUB_ACTIONS) {
  console.log(
    `::warning title=Brand assets missing::${header}. See docs/product/brand-assets-required.md`,
  );
}
console.log(header);
for (const item of missing) console.log(`  - ${item}`);
console.log('See docs/product/brand-assets-required.md');
process.exit(reportOnly ? 0 : 1);
