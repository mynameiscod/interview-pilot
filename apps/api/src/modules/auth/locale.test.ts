import { describe, expect, it } from 'vitest';
import { pickLocale, resolveMessageLocale } from './locale.js';

describe('pickLocale', () => {
  it('returns null for a missing or unsupported header', () => {
    expect(pickLocale(undefined)).toBeNull();
    expect(pickLocale('')).toBeNull();
    expect(pickLocale('fr-FR, de;q=0.8, *;q=0.5')).toBeNull();
  });

  it('matches region subtags to their language, case-insensitively', () => {
    expect(pickLocale('hi-IN')).toBe('hi');
    expect(pickLocale('TE-in,en;q=0.5')).toBe('te');
  });

  it('orders by q-value, keeping header order for ties', () => {
    expect(pickLocale('en;q=0.4, te;q=0.9, hi;q=0.7')).toBe('te');
    expect(pickLocale('fr, hi, en')).toBe('hi');
    expect(pickLocale('en-GB,en;q=0.9,hi;q=0.8')).toBe('en');
  });

  it('ignores q=0 and malformed q-values', () => {
    expect(pickLocale('hi;q=0, te;q=0.1')).toBe('te');
    expect(pickLocale('hi;q=abc, en;q=0.2')).toBe('en');
  });

  it('accepts a repeated header', () => {
    expect(pickLocale(['fr', 'te;q=0.5'])).toBe('te');
  });
});

describe('resolveMessageLocale', () => {
  it('prefers the request field, then Accept-Language, then English', () => {
    expect(resolveMessageLocale({ requested: 'hi', acceptLanguage: 'te' })).toBe('hi');
    expect(resolveMessageLocale({ acceptLanguage: 'te-IN,en;q=0.8' })).toBe('te');
    expect(resolveMessageLocale({ acceptLanguage: 'fr' })).toBe('en');
    expect(resolveMessageLocale({})).toBe('en');
  });
});
