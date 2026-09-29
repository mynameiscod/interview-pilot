import { describe, expect, it } from 'vitest';
import { collectIconNames, subsetBootstrapIconsCss } from './bootstrap-icons-subset';

const CSS =
  '@font-face{font-family:bootstrap-icons;src:url("fonts/bootstrap-icons.woff2") format("woff2")}' +
  '.bi::before,[class^=bi-]::before{display:inline-block}' +
  '.bi-alarm::before{content:"\\f102"}.bi-alarm-fill::before{content:"\\f101"}' +
  '.bi-house-door::before{content:"\\f425"}.bi-123::before{content:"\\f67f"}';

describe('collectIconNames', () => {
  it('finds literal icon classes in source text', () => {
    const names = collectIconNames(
      `<i className="bi bi-house-door" /> { icon: 'bi-alarm-fill' } const x = "cbi-token";`,
    );
    expect([...names].sort()).toEqual(['alarm-fill', 'house-door']);
  });

  it('accumulates across files', () => {
    const names = collectIconNames('bi-alarm');
    collectIconNames('bi-123', names);
    expect([...names].sort()).toEqual(['123', 'alarm']);
  });
});

describe('subsetBootstrapIconsCss', () => {
  it('keeps the font face, base rule and used icons only', () => {
    const out = subsetBootstrapIconsCss(CSS, new Set(['alarm', 'house-door']));
    expect(out).toContain('@font-face');
    expect(out).toContain('[class^=bi-]::before{display:inline-block}');
    expect(out).toContain('.bi-alarm::before');
    expect(out).toContain('.bi-house-door::before');
    // A prefix match must not keep a different icon.
    expect(out).not.toContain('.bi-alarm-fill::before');
    expect(out).not.toContain('.bi-123::before');
  });

  it('returns the base rules when nothing is used', () => {
    const out = subsetBootstrapIconsCss(CSS, new Set());
    expect(out).not.toMatch(/\.bi-[a-z0-9-]+::before/);
    expect(out).toContain('@font-face');
  });
});
