import { createLogger } from '@cbi/config';
import {
  AiUsageModel,
  connectMongo,
  disconnectMongo,
  ensureIndexes,
  mongoose,
  ProviderHealthModel,
} from '@cbi/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { HEALTH_WINDOW_MS, rollupProviderHealth } from './provider-health.js';

const MONGODB_URI = process.env.MONGODB_URI;
if (
  !MONGODB_URI ||
  !/test/i.test(new URL(MONGODB_URI.replace(/^mongodb(\+srv)?:/, 'http:')).pathname)
) {
  throw new Error(
    'Integration tests need MONGODB_URI pointing at a database whose name contains "test".',
  );
}

beforeAll(async () => {
  await connectMongo({
    uri: MONGODB_URI,
    autoIndex: false,
    logger: createLogger({ service: 'test', level: 'silent' }),
  });
  await ensureIndexes();
});
beforeEach(async () => {
  // Native driver: the aiUsage model refuses deletes (append-only).
  await mongoose.connection.db!.collection('aiUsage').deleteMany({});
  await mongoose.connection.db!.collection('providerHealth').deleteMany({});
});
afterAll(disconnectMongo);

describe('rollupProviderHealth', () => {
  it('writes one idempotent 5-minute window per model', async () => {
    const now = new Date(Math.floor(Date.now() / HEALTH_WINDOW_MS) * HEALTH_WINDOW_MS + 120_000);
    const modelRef = new mongoose.Types.ObjectId();
    const row = (outcome: string, latencyMs: number, feature = 'interview.question') => ({
      at: new Date(now.getTime() - 60_000),
      feature,
      provider: 'anthropic',
      providerId: new mongoose.Types.ObjectId(),
      modelRef,
      model: 'claude-opus-5',
      units: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1, requests: 1 },
      latencyMs,
      attempt: 1,
      outcome,
      costMicros: 0,
      currency: 'USD',
    });
    await AiUsageModel.insertMany([
      row('SUCCESS', 800),
      row('SUCCESS', 1200),
      row('INVALID_OUTPUT', 900),
      row('PROVIDER_ERROR', 30_000),
      row('SUCCESS', 50, 'admin.test'),
    ]);
    expect(await rollupProviderHealth(now)).toBe(1);
    await rollupProviderHealth(now);
    const docs = await ProviderHealthModel.find().lean();
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({
      model: 'claude-opus-5',
      window: '5m',
      calls: 4,
      failures: 1,
      errorRate: 0.25,
      p50LatencyMs: 900,
      p95LatencyMs: 1200,
      status: 'DEGRADED',
    });
  });
});
