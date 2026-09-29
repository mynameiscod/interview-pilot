/**
 * Build-time helpers that cut the Bootstrap Icons stylesheet down to the icons
 * the apps reference. The full sheet carries ~2,000 `.bi-*::before` rules
 * (~76 KB); the apps use about 150. Used by the Vite plugin in vite.shared.ts.
 *
 * Icons must be written as literal class names (`'bi-house-door'`), never
 * assembled at runtime (`'bi-' + name`), or they will be stripped.
 */

const ICON_RULE = /\.bi-([a-z0-9]+(?:-[a-z0-9]+)*)::before\{content:"[^"]*"\}/g;
const ICON_REFERENCE = /\bbi-([a-z0-9]+(?:-[a-z0-9]+)*)/g;

/** Adds every `bi-<name>` referenced in `source` to `into`. */
export function collectIconNames(source: string, into: Set<string> = new Set()): Set<string> {
  for (const match of source.matchAll(ICON_REFERENCE)) into.add(match[1]!);
  return into;
}

/** Drops `.bi-<name>::before` rules for icons not in `used`; everything else is kept. */
export function subsetBootstrapIconsCss(css: string, used: ReadonlySet<string>): string {
  return css.replace(ICON_RULE, (rule, name: string) => (used.has(name) ? rule : ''));
}
