import { describe, expect, it } from 'vitest';
import { toUiLocale } from './ui-locale';

describe('toUiLocale', () => {
  it('maps supported languages, including region variants', () => {
    expect(toUiLocale('en')).toBe('en');
    expect(toUiLocale('hi-IN')).toBe('hi');
    expect(toUiLocale('TE')).toBe('te');
  });

  it('returns undefined for missing or unsupported languages', () => {
    expect(toUiLocale(undefined)).toBeUndefined();
    expect(toUiLocale('')).toBeUndefined();
    expect(toUiLocale('fr')).toBeUndefined();
    expect(toUiLocale('cimode')).toBeUndefined();
  });
});
