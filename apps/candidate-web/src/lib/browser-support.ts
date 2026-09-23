/**
 * Baseline capabilities the app needs to run at all. Interview-specific
 * capabilities (microphone, camera, MediaRecorder codecs) are checked later in
 * the Device Check step, where failures get specific, actionable guidance.
 */
export interface BrowserEnvironment {
  fetch?: unknown;
  AbortController?: unknown;
  structuredClone?: unknown;
  CSS?: { supports?: (property: string, value: string) => boolean };
}

export type MissingFeature = 'fetch' | 'abort-controller' | 'structured-clone' | 'css-variables';

export function detectMissingFeatures(
  env: BrowserEnvironment = globalThis as BrowserEnvironment,
): MissingFeature[] {
  const missing: MissingFeature[] = [];
  if (typeof env.fetch !== 'function') missing.push('fetch');
  if (typeof env.AbortController !== 'function') missing.push('abort-controller');
  if (typeof env.structuredClone !== 'function') missing.push('structured-clone');
  if (!env.CSS?.supports?.('color', 'var(--cb-test)')) missing.push('css-variables');
  return missing;
}
