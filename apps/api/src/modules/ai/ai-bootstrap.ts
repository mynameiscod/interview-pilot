import { providerSecretContext, SecretDecryptionError } from '@cbi/ai-core';
import type { ApiEnv, Logger } from '@cbi/config';
import { AiProviderModel, ensureAiCatalog } from '@cbi/db';
import type { AiProviderKey } from '@cbi/shared-types';
import type { AuditService } from '../../lib/audit.js';
import type { AiRuntime } from '@cbi/ai-runtime';

interface BootstrapDeps {
  env: ApiEnv;
  ai: AiRuntime;
  audit: AuditService;
  logger: Logger;
}

/**
 * Runs at API start (idempotent, safe with several replicas):
 * 1. seeds missing providers, models and routes (never changes existing ones);
 * 2. imports AI_BOOTSTRAP_* keys into providers that have no key yet;
 * 3. re-encrypts stored keys that use an older master key (rotation).
 */
export async function bootstrapAi({ env, ai, audit, logger }: BootstrapDeps) {
  const seeded = await ensureAiCatalog({ mockMode: ai.mockEnabled });
  let changed = seeded.providersCreated + seeded.modelsCreated + seeded.routesCreated > 0;

  const bootstrapKeys: [AiProviderKey, string | undefined][] = [
    ['openai', env.AI_BOOTSTRAP_OPENAI_API_KEY],
    ['anthropic', env.AI_BOOTSTRAP_ANTHROPIC_API_KEY],
    ['gemini', env.AI_BOOTSTRAP_GEMINI_API_KEY],
  ];
  let imported = 0;
  for (const [key, apiKey] of bootstrapKeys) {
    if (!apiKey) continue;
    const encrypted = ai.secrets.encrypt(apiKey, providerSecretContext(key));
    // Conditional on "no key yet", so a key set in Admin is never overwritten.
    const res = await AiProviderModel.updateOne(
      { key, credential: null },
      { $set: { credential: { ...encrypted, updatedAt: new Date() } } },
    );
    if (res.modifiedCount === 1) {
      imported += 1;
      await audit.record({
        actorType: 'SYSTEM',
        action: 'ai.provider_credential_bootstrapped',
        resourceType: 'aiProvider',
        resourceId: key,
        details: { provider: key, last4: encrypted.last4, keyId: encrypted.keyId },
      });
    }
  }

  let rotated = 0;
  const stale = await AiProviderModel.find({
    credential: { $ne: null },
    'credential.keyId': { $ne: ai.secrets.currentKeyId },
  }).lean();
  for (const provider of stale) {
    const current = provider.credential!;
    const context = providerSecretContext(provider.key);
    try {
      const plaintext = ai.secrets.decrypt(current, context);
      const next = ai.secrets.encrypt(plaintext, context);
      // Conditional on the old ciphertext so concurrent replicas rotate once.
      const res = await AiProviderModel.updateOne(
        { _id: provider._id, 'credential.ciphertext': current.ciphertext },
        { $set: { credential: { ...next, updatedAt: current.updatedAt } } },
      );
      if (res.modifiedCount === 1) {
        rotated += 1;
        await audit.record({
          actorType: 'SYSTEM',
          action: 'ai.provider_credential_rotated',
          resourceType: 'aiProvider',
          resourceId: String(provider._id),
          details: { provider: provider.key, fromKeyId: current.keyId, toKeyId: next.keyId },
        });
      }
    } catch (err) {
      if (!(err instanceof SecretDecryptionError)) throw err;
      // Keep serving: the router skips this provider until an admin re-enters the key.
      logger.error(
        { provider: provider.key, keyId: current.keyId },
        'stored AI provider key cannot be decrypted; add its master key to AI_SECRETS_PREVIOUS_KEYS or re-enter it in Admin',
      );
    }
  }

  changed ||= imported + rotated > 0;
  if (changed) await ai.announceChange();
  const summary = {
    ...seeded,
    keysImported: imported,
    keysRotated: rotated,
    mockEnabled: ai.mockEnabled,
  };
  logger.info(summary, 'ai catalog ready');
  return summary;
}
