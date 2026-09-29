import { describe, expect, it } from 'vitest';
import { resources, SUPPORTED_LOCALES } from './index';

function flattenKeys(obj: object, prefix = ''): string[] {
  return Object.entries(obj).flatMap(([key, value]) =>
    value && typeof value === 'object'
      ? flattenKeys(value as object, `${prefix}${key}.`)
      : [`${prefix}${key}`],
  );
}

const placeholders = (text: string) =>
  [...text.matchAll(/{{\s*(\w+)\s*}}/g)].map((m) => m[1]).sort();

function flattenValues(obj: object, prefix = ''): [string, string][] {
  return Object.entries(obj).flatMap(([key, value]) =>
    value && typeof value === 'object'
      ? flattenValues(value as object, `${prefix}${key}.`)
      : [[`${prefix}${key}`, String(value)] as [string, string]],
  );
}

describe.each(['common', 'legal'] as const)('UI translations (%s)', (ns) => {
  const englishKeys = flattenKeys(resources.en[ns]).sort();

  it('registers a resource bundle for every supported locale', () => {
    expect(Object.keys(resources).sort()).toEqual([...SUPPORTED_LOCALES].sort());
  });

  it.each(SUPPORTED_LOCALES.filter((l) => l !== 'en'))(
    '%s has exactly the same keys as English',
    (lng) => {
      expect(flattenKeys(resources[lng][ns]).sort()).toEqual(englishKeys);
    },
  );

  it.each(SUPPORTED_LOCALES)('%s has no empty strings', (lng) => {
    const values = JSON.stringify(resources[lng][ns]);
    expect(values).not.toMatch(/:""/);
  });

  it.each(SUPPORTED_LOCALES.filter((l) => l !== 'en'))(
    '%s uses the same placeholders as English',
    (lng) => {
      const english = new Map(flattenValues(resources.en[ns]));
      for (const [key, value] of flattenValues(resources[lng][ns])) {
        expect([key, placeholders(value)]).toEqual([key, placeholders(english.get(key) ?? '')]);
      }
    },
  );
});
