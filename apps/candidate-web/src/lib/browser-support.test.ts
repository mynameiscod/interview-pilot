import { describe, expect, it } from 'vitest';
import { detectMissingFeatures } from './browser-support';

const modern = {
  fetch: () => undefined,
  AbortController: function AbortController() {},
  structuredClone: () => undefined,
  CSS: { supports: () => true },
};

describe('detectMissingFeatures', () => {
  it('reports nothing for a modern browser', () => {
    expect(detectMissingFeatures(modern)).toEqual([]);
  });

  it('lists every missing baseline feature', () => {
    expect(detectMissingFeatures({ CSS: { supports: () => false } })).toEqual([
      'fetch',
      'abort-controller',
      'structured-clone',
      'css-variables',
    ]);
  });
});
