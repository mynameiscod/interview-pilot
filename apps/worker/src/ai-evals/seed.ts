import { providerSecretContext } from '@cbi/ai-core';
import type { AiRuntime } from '@cbi/ai-runtime';
import { AiProviderModel, ensureAiCatalog, ensureIndexes, ensureLibraryCatalog } from '@cbi/db';
import type { AiProviderKey } from '@cbi/shared-types';

/** Environment variables holding provider keys for a seeded eval database (CI secrets). */
export const EVAL_KEY_VARS: Readonly<Record<'anthropic' | 'openai' | 'gemini', string>> = {
  anthropic: 'AI_EVAL_ANTHROPIC_API_KEY',
  openai: 'AI_EVAL_OPENAI_API_KEY',
  gemini: 'AI_EVAL_GEMINI_API_KEY',
};

/**
 * Only throwaway databases may be seeded: the name must contain "eval" or
 * "test", so `--seed` can never touch a real deployment.
 */
export function seedableDatabase(uri: string): boolean {
  const name = new URL(uri.replace(/^mongodb(\+srv)?:/, 'http:')).pathname.slice(1);
  return /eval|test/i.test(name);
}

/**
 * Prepares an empty database for the eval runner (nightly CI): indexes, the
 * default AI catalog and routes, the library with its seeded prompts, and
 * provider keys from AI_EVAL_*_API_KEY for providers without a key.
 * Returns the providers that received a key.
 */
export async function seedEvalDatabase(
  ai: Pick<AiRuntime, 'secrets' | 'mockEnabled' | 'invalidateLocal'>,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<AiProviderKey[]> {
  await ensureIndexes();
  await ensureAiCatalog({ mockMode: ai.mockEnabled });
  await ensureLibraryCatalog();
  const keyed: AiProviderKey[] = [];
  for (const [provider, variable] of Object.entries(EVAL_KEY_VARS) as [
    keyof typeof EVAL_KEY_VARS,
    string,
  ][]) {
    const apiKey = env[variable]?.trim();
    if (!apiKey) continue;
    const encrypted = ai.secrets.encrypt(apiKey, providerSecretContext(provider));
    const res = await AiProviderModel.updateOne(
      { key: provider, credential: null },
      { $set: { credential: { ...encrypted, updatedAt: new Date() } } },
    );
    if (res.modifiedCount === 1) keyed.push(provider);
  }
  ai.invalidateLocal();
  return keyed;
}
