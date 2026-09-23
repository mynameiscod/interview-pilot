import { describe, expect, it } from 'vitest';
import { resources, SUPPORTED_LOCALES } from './index';

function flattenKeys(obj: object, prefix = ''): string[] {
  return Object.entries(obj).flatMap(([key, value]) =>
    value && typeof value === 'object'
      ? flattenKeys(value as object, `${prefix}${key}.`)
      : [`${prefix}${key}`],
  );
}

describe('UI translations', () => {
  const englishKeys = flattenKeys(resources.en.common).sort();

  it('registers a resource bundle for every supported locale', () => {
    expect(Object.keys(resources).sort()).toEqual([...SUPPORTED_LOCALES].sort());
  });

  it.each(SUPPORTED_LOCALES.filter((l) => l !== 'en'))(
    '%s has exactly the same keys as English',
    (lng) => {
      expect(flattenKeys(resources[lng].common).sort()).toEqual(englishKeys);
    },
  );

  it.each(SUPPORTED_LOCALES)('%s has no empty strings', (lng) => {
    const values = JSON.stringify(resources[lng].common);
    expect(values).not.toMatch(/:""/);
  });
});
