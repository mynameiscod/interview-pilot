import {
  createAiRouter,
  createCachedConfigSource,
  createPromptRegistry,
  createRedisCoordination,
  createSecretBox,
  parseKeyList,
  parseMasterKey,
  type AdapterRegistry,
  type LlmAdapter,
  type UsageSink,
} from '@cbi/ai-core';
import type { Logger } from '@cbi/config';
import { createMongoUsageSink, loadActivePrompt, loadAiRuntimeConfig, type Redis } from '@cbi/db';
import {
  createAnthropicLlmAdapter,
  createGeminiLlmAdapter,
  createMockLlmAdapter,
  createOpenAiLlmAdapter,
} from '@cbi/provider-adapters';
import type { AiProviderKey, AppEnv } from '@cbi/shared-types';

/** The environment settings the AI runtime reads (satisfied by ApiEnv and WorkerEnv). */
export interface AiRuntimeSettings {
  APP_ENV: AppEnv;
  AI_MOCK_MODE: boolean;
  AI_SECRETS_MASTER_KEY: string;
  AI_SECRETS_KEY_ID: string;
  AI_SECRETS_PREVIOUS_KEYS?: string;
  AI_CONFIG_CACHE_TTL_SEC: number;
}

/** Redis pub/sub channel: any message means "AI config or prompts changed". */
export const AI_CONFIG_CHANNEL = 'cbi:ai:config-changed' as const;

/** The mock is registered only in development/test with AI_MOCK_MODE=true (env validation enforces the rest). */
export function mockAllowed(env: Pick<AiRuntimeSettings, 'APP_ENV' | 'AI_MOCK_MODE'>): boolean {
  return env.AI_MOCK_MODE && (env.APP_ENV === 'development' || env.APP_ENV === 'test');
}

export function buildAdapterRegistry(env: AiRuntimeSettings): AdapterRegistry {
  const adapters = new Map<AiProviderKey, LlmAdapter>([
    ['anthropic', createAnthropicLlmAdapter()],
    ['openai', createOpenAiLlmAdapter()],
    ['gemini', createGeminiLlmAdapter()],
  ]);
  if (mockAllowed(env)) adapters.set('mock', createMockLlmAdapter());
  return { llm: (key) => adapters.get(key) };
}

export function buildSecretBox(env: AiRuntimeSettings) {
  return createSecretBox({
    currentKeyId: env.AI_SECRETS_KEY_ID,
    keys: {
      ...parseKeyList(env.AI_SECRETS_PREVIOUS_KEYS),
      [env.AI_SECRETS_KEY_ID]: parseMasterKey(env.AI_SECRETS_MASTER_KEY),
    },
  });
}

export interface AiRuntimeOptions {
  env: AiRuntimeSettings;
  logger: Logger;
  redis: Redis;
  adapters?: AdapterRegistry;
  usage?: UsageSink;
}

/**
 * Everything a process needs to make AI calls: the router (with Redis
 * coordination and MongoDB metering), the prompt registry and the cache-bust
 * plumbing. Admin changes publish on AI_CONFIG_CHANNEL; every API and worker
 * process drops its cached config on receipt.
 */
export function buildAiRuntime(opts: AiRuntimeOptions) {
  const { env, logger, redis } = opts;
  const ttlMs = env.AI_CONFIG_CACHE_TTL_SEC * 1000;
  const secrets = buildSecretBox(env);
  const adapters = opts.adapters ?? buildAdapterRegistry(env);
  const config = createCachedConfigSource({ load: loadAiRuntimeConfig, ttlMs, logger });
  const prompts = createPromptRegistry({ loadActive: loadActivePrompt, ttlMs });
  const router = createAiRouter({
    config,
    adapters,
    secrets,
    coordination: createRedisCoordination(redis),
    usage: opts.usage ?? createMongoUsageSink(),
    logger,
  });

  function invalidateLocal() {
    config.invalidate();
    prompts.invalidate();
  }

  return {
    router,
    prompts,
    secrets,
    adapters,
    config,
    mockEnabled: mockAllowed(env),
    invalidateLocal,
    /** Drop caches here and tell every other process to do the same. */
    async announceChange() {
      invalidateLocal();
      try {
        await redis.publish(AI_CONFIG_CHANNEL, String(Date.now()));
      } catch (err) {
        // Other processes still pick the change up within the cache TTL.
        logger.warn({ err }, 'ai config change broadcast failed');
      }
    },
    /** Subscribes on a dedicated connection; returns a function that unsubscribes. */
    async listenForChanges(): Promise<() => Promise<void>> {
      const subscriber = redis.duplicate();
      await subscriber.connect();
      await subscriber.subscribe(AI_CONFIG_CHANNEL);
      subscriber.on('message', (channel) => {
        if (channel === AI_CONFIG_CHANNEL) invalidateLocal();
      });
      return async () => {
        await subscriber.quit().catch(() => undefined);
      };
    },
  };
}

export type AiRuntime = ReturnType<typeof buildAiRuntime>;
