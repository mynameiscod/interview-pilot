import { randomBytes } from 'node:crypto';
import {
  AiProviderError,
  createSecretBox,
  providerSecretContext,
  type AdapterRegistry,
  type LlmAdapter,
  type LlmCallResult,
} from '@cbi/ai-core';
import {
  AiModelModel,
  AiProviderModel,
  AiRouteModel,
  AiUsageModel,
  AuditLogModel,
  PromptTemplateModel,
  UserModel,
  UserProfileModel,
} from '@cbi/db';
import { createMockLlmAdapter } from '@cbi/provider-adapters';
import {
  AiModelSummary,
  AiProviderSummary,
  AiRouteSummary,
  AiUsageReport,
  PromptTemplateSummary,
  type AdminRole,
} from '@cbi/shared-types';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildTestApp, TEST_AI_MASTER_KEY, TEST_ORIGIN } from '../../test-support/harness.js';
import { signInWithEmail, useIntegrationServices } from '../../test-support/integration.js';
import { bootstrapAi } from './ai-bootstrap.js';

const { redis } = useIntegrationServices();

/** A controllable stand-in for the Anthropic adapter; everything else is the real mock. */
function scriptedAnthropic() {
  const queue: (LlmCallResult | AiProviderError)[] = [];
  const keys: string[] = [];
  const adapter: LlmAdapter = {
    providerKey: 'anthropic',
    async generate(input) {
      keys.push(input.credentials.apiKey);
      const next =
        queue.shift() ?? new AiProviderError('anthropic', 'PROVIDER_ERROR', '529', 'overloaded');
      if (next instanceof AiProviderError) throw next;
      return next;
    },
  };
  const mock = createMockLlmAdapter();
  const registry: AdapterRegistry = {
    llm: (key) => (key === 'anthropic' ? adapter : key === 'mock' ? mock : undefined),
  };
  return { registry, queue, keys };
}

let t: Awaited<ReturnType<typeof buildTestApp>>;
let anthropic: ReturnType<typeof scriptedAnthropic>;

beforeEach(async () => {
  anthropic = scriptedAnthropic();
  t = await buildTestApp({ redis, aiAdapters: anthropic.registry });
  await bootstrapAi({
    env: t.env,
    ai: t.container.ai,
    audit: t.container.audit,
    logger: t.container.logger,
  });
});

async function adminAs(roles: AdminRole[], email = `${roles[0]!.toLowerCase()}@codebegun.com`) {
  const user = await UserModel.create({ primaryEmail: email, adminRoles: roles });
  await UserProfileModel.create({ userId: user._id });
  const { accessToken } = await signInWithEmail(t.app, t.email.sent, email, 'admin');
  return (method: 'get' | 'post' | 'put' | 'patch' | 'delete', path: string) =>
    request(t.app)
      [method](`/api/v1/admin${path}`)
      .set('Origin', TEST_ORIGIN)
      .set('Authorization', `Bearer ${accessToken}`);
}

const providers = async (as: Awaited<ReturnType<typeof adminAs>>) =>
  z.array(AiProviderSummary).parse((await as('get', '/ai/providers').expect(200)).body.data);
const models = async (as: Awaited<ReturnType<typeof adminAs>>) =>
  z.array(AiModelSummary).parse((await as('get', '/ai/models').expect(200)).body.data);

const opusReply = (text: string): LlmCallResult => ({
  text,
  servedModel: 'claude-opus-5',
  finishReason: 'stop',
  usage: { inputTokens: 2000, cachedInputTokens: 0, outputTokens: 400, requests: 1 },
});

describe('catalog bootstrap', () => {
  it('seeds providers, priced models and routes once, and never overwrites admin changes', async () => {
    expect(await AiProviderModel.countDocuments()).toBe(4); // anthropic, openai, gemini, mock (test env)
    const opus = await AiModelModel.findOne({ modelId: 'claude-opus-5' }).lean();
    expect(opus!.pricing.map((p) => [p.unit, p.pricePerUnitMicros]).sort()).toEqual([
      ['PER_1M_CACHED_INPUT_TOKENS', 500_000],
      ['PER_1M_INPUT_TOKENS', 5_000_000],
      ['PER_1M_OUTPUT_TOKENS', 25_000_000],
    ]);
    const route = await AiRouteModel.findOne({ feature: 'interview.question' }).lean();
    expect(route!.chain).toHaveLength(3);
    await AiModelModel.updateOne(
      { modelId: 'claude-opus-5' },
      { $set: { displayName: 'Renamed' } },
    );
    const again = await bootstrapAi({
      env: t.env,
      ai: t.container.ai,
      audit: t.container.audit,
      logger: t.container.logger,
    });
    expect(again).toMatchObject({ providersCreated: 0, modelsCreated: 0, routesCreated: 0 });
    expect((await AiModelModel.findOne({ modelId: 'claude-opus-5' }).lean())!.displayName).toBe(
      'Renamed',
    );
  });

  it('imports bootstrap keys only into providers without one', async () => {
    const env = { ...t.env, AI_BOOTSTRAP_ANTHROPIC_API_KEY: 'sk-ant-bootstrap-1234' };
    const first = await bootstrapAi({
      env,
      ai: t.container.ai,
      audit: t.container.audit,
      logger: t.container.logger,
    });
    expect(first.keysImported).toBe(1);
    const second = await bootstrapAi({
      env: { ...env, AI_BOOTSTRAP_ANTHROPIC_API_KEY: 'sk-ant-other-9999' },
      ai: t.container.ai,
      audit: t.container.audit,
      logger: t.container.logger,
    });
    expect(second.keysImported).toBe(0);
    const stored = (await AiProviderModel.findOne({ key: 'anthropic' }).lean())!.credential!;
    expect(stored.last4).toBe('1234');
    expect(JSON.stringify(stored)).not.toContain('bootstrap');
  });

  it('re-encrypts stored keys with the new master key after rotation', async () => {
    const oldKey = Buffer.from(TEST_AI_MASTER_KEY, 'base64');
    const encrypted = createSecretBox({ currentKeyId: 'k1', keys: { k1: oldKey } }).encrypt(
      'sk-ant-rotate-5678',
      providerSecretContext('anthropic'),
    );
    await AiProviderModel.updateOne(
      { key: 'anthropic' },
      { $set: { credential: { ...encrypted, updatedAt: new Date() } } },
    );

    const newKey = randomBytes(32).toString('base64');
    const rotatedApp = await buildTestApp({
      redis,
      aiAdapters: anthropic.registry,
      env: {
        AI_SECRETS_MASTER_KEY: newKey,
        AI_SECRETS_KEY_ID: 'k2',
        AI_SECRETS_PREVIOUS_KEYS: `k1:${TEST_AI_MASTER_KEY}`,
      },
    });
    const summary = await bootstrapAi({
      env: rotatedApp.env,
      ai: rotatedApp.container.ai,
      audit: rotatedApp.container.audit,
      logger: rotatedApp.container.logger,
    });
    expect(summary.keysRotated).toBe(1);
    const stored = (await AiProviderModel.findOne({ key: 'anthropic' }).lean())!.credential!;
    expect(stored.keyId).toBe('k2');
    expect(
      rotatedApp.container.ai.secrets.decrypt(stored, providerSecretContext('anthropic')),
    ).toBe('sk-ant-rotate-5678');
    expect(await AuditLogModel.countDocuments({ action: 'ai.provider_credential_rotated' })).toBe(
      1,
    );
  });
});

describe('access control', () => {
  it('keeps provider secrets and routing to super admins', async () => {
    const ops = await adminAs(['OPERATIONS_ADMIN']);
    const [anthropicProvider] = (await providers(ops)).filter((p) => p.key === 'anthropic');
    await ops('put', `/ai/providers/${anthropicProvider!.id}/credential`)
      .send({ apiKey: 'sk-ant-nope-1234', reason: 'try' })
      .expect(403);
    await ops('put', '/ai/routes/interview.question')
      .send({ active: true, chain: [], reason: 'x' })
      .expect(403);
    await ops('get', '/ai/usage').expect(200);
  });

  it('lets finance see cost but not provider configuration, and content admins manage prompts only', async () => {
    const finance = await adminAs(['FINANCE_ADMIN']);
    await finance('get', '/ai/usage').expect(200);
    await finance('get', '/ai/providers').expect(403);
    const content = await adminAs(['CONTENT_ADMIN']);
    await content('get', '/prompts').expect(200);
    await content('get', '/ai/models').expect(403);
  });

  it('rejects candidate tokens', async () => {
    const { accessToken } = await signInWithEmail(t.app, t.email.sent, 'candidate@example.com');
    await request(t.app)
      .get('/api/v1/admin/ai/providers')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(401);
  });
});

describe('provider credentials', () => {
  it('stores keys encrypted, returns only last4 and audits without the key', async () => {
    const root = await adminAs(['SUPER_ADMIN']);
    const target = (await providers(root)).find((p) => p.key === 'anthropic')!;
    expect(target.credential).toBeNull();
    const res = await root('put', `/ai/providers/${target.id}/credential`)
      .send({ apiKey: 'sk-ant-api03-SECRETVALUE-abcd', reason: 'Initial production key' })
      .expect(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.data.credential).toMatchObject({ last4: 'abcd', keyId: 'k1' });
    expect(JSON.stringify(res.body)).not.toContain('SECRETVALUE');

    const raw = await AiProviderModel.findById(target.id).lean();
    expect(JSON.stringify(raw)).not.toContain('SECRETVALUE');
    const audit = await AuditLogModel.findOne({ action: 'ai.provider_credential_set' }).lean();
    expect(audit!.details).toMatchObject({ provider: 'anthropic', last4: 'abcd', replaced: false });
    expect(JSON.stringify(audit)).not.toContain('SECRETVALUE');
    expect(JSON.stringify((await root('get', '/ai/providers').expect(200)).body)).not.toContain(
      'SECRETVALUE',
    );

    // The router decrypts it in-process for the call.
    anthropic.queue.push(opusReply('Tell me about your last project.'));
    await t.container.ai.router.run('interview.question', {
      messages: [{ role: 'user', content: 'Ask.' }],
    });
    expect(anthropic.keys).toEqual(['sk-ant-api03-SECRETVALUE-abcd']);

    await root('delete', `/ai/providers/${target.id}/credential`)
      .send({ reason: 'Revoked at provider' })
      .expect(200);
    await root('delete', `/ai/providers/${target.id}/credential`)
      .send({ reason: 'again' })
      .expect(409);
  });

  it('refuses keys for the mock provider', async () => {
    const root = await adminAs(['SUPER_ADMIN']);
    const mock = (await providers(root)).find((p) => p.key === 'mock')!;
    await root('put', `/ai/providers/${mock.id}/credential`)
      .send({ apiKey: 'whatever-1234', reason: 'x x' })
      .expect(400);
  });
});

describe('routing, fallback and metering (real MongoDB + Redis)', () => {
  async function withAnthropicKey() {
    const root = await adminAs(['SUPER_ADMIN']);
    const target = (await providers(root)).find((p) => p.key === 'anthropic')!;
    await root('put', `/ai/providers/${target.id}/credential`).send({
      apiKey: 'sk-ant-live-0000',
      reason: 'test key',
    });
    return root;
  }

  it('skips unkeyed providers and is served by the labelled mock in development', async () => {
    const result = await t.container.ai.router.run(
      'role.analyze',
      { messages: [{ role: 'user', content: 'Analyse this role.' }] },
      { correlationId: 'req-42', sessionId: 'sess-1' },
    );
    expect(result.text).toMatch(/^\[mock\]/);
    expect(result.attempts.map((a) => [a.model, a.detail])).toEqual([
      ['claude-opus-5', 'no_credentials'],
      ['claude-sonnet-5', 'no_credentials'],
      ['mock-llm', null],
    ]);
    const rows = await AiUsageModel.find().lean();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      provider: 'mock',
      feature: 'role.analyze',
      sessionId: 'sess-1',
      correlationId: 'req-42',
    });
  });

  it('meters cost with the price snapshot in force and falls back on provider failure', async () => {
    const root = await withAnthropicKey();
    anthropic.queue.push(opusReply('Opus answer'));
    const served = await t.container.ai.router.run('interview.question', {
      messages: [{ role: 'user', content: 'Q' }],
    });
    expect(served.model.modelId).toBe('claude-opus-5');
    // 2,000 × $5/1M + 400 × $25/1M = $0.02 = 20,000 micro-USD.
    expect(served.costMicros).toBe(20_000);
    const row = await AiUsageModel.findOne({ outcome: 'SUCCESS' }).lean();
    expect(
      row!.priceSnapshot!.entries.map((e) => e.pricePerUnitMicros).sort((a, b) => a - b),
    ).toEqual([500_000, 5_000_000, 25_000_000]);

    // Opus overloaded twice (1 retry), Sonnet overloaded twice, the mock serves.
    const fallback = await t.container.ai.router.run('interview.question', {
      messages: [{ role: 'user', content: 'Q' }],
    });
    expect(fallback.model.modelId).toBe('mock-llm');
    expect(fallback.attempts.map((a) => a.outcome)).toEqual([
      'PROVIDER_ERROR',
      'PROVIDER_ERROR',
      'SUCCESS',
    ]);

    const report = AiUsageReport.parse(
      (await root('get', '/ai/usage').query({ groupBy: 'model' }).expect(200)).body.data,
    );
    expect(report.totals.calls).toBe(6);
    expect(report.totals.failures).toBe(4);
    expect(report.totals.costMicros).toEqual({ USD: 20_000 });
    expect(report.rows.find((r) => r.key.startsWith('Claude Opus 5'))).toMatchObject({
      calls: 3,
      failures: 2,
    });

    const entries = (await root('get', '/ai/usage/entries').query({ limit: 2 }).expect(200)).body
      .data;
    expect(entries.items).toHaveLength(2);
    expect(entries.nextCursor).toBeTruthy();
  });

  it('applies route changes immediately and rejects models without the capability', async () => {
    const root = await adminAs(['SUPER_ADMIN']);
    const all = await models(root);
    const mock = all.find((m) => m.modelId === 'mock-llm')!;
    const res = await root('put', '/ai/routes/report.recommendations')
      .send({
        active: true,
        chain: [{ modelId: mock.id, priority: 0 }],
        reason: 'Mock only while keys are pending',
      })
      .expect(200);
    expect(AiRouteSummary.parse(res.body.data).chain).toEqual([
      {
        modelId: mock.id,
        priority: 0,
        label: 'Mock LLM (deterministic) (Mock (development only))',
      },
    ]);
    const result = await t.container.ai.router.run('report.recommendations', {
      messages: [{ role: 'user', content: 'Plan' }],
    });
    expect(result.attempts).toHaveLength(1);

    const stt = await root('post', '/ai/models')
      .send({
        providerId: mock.providerId,
        modelId: 'mock-stt',
        displayName: 'Mock STT',
        capabilities: ['STT'],
      })
      .expect(201);
    await root('put', '/ai/routes/interview.question')
      .send({
        active: true,
        chain: [{ modelId: stt.body.data.id, priority: 0 }],
        reason: 'wrong capability',
      })
      .expect(400);
    await root('put', '/ai/routes/admin.test')
      .send({ active: true, chain: [], reason: 'nope' })
      .expect(404);

    await root('put', '/ai/routes/role.analyze')
      .send({ active: false, chain: [], reason: 'Paused for review' })
      .expect(200);
    await expect(
      t.container.ai.router.run('role.analyze', { messages: [{ role: 'user', content: 'x' }] }),
    ).rejects.toThrow(/No active AI route/);
    const audit = await AuditLogModel.findOne({
      action: 'ai.route_updated',
      resourceId: 'role.analyze',
    }).lean();
    expect(audit!.details).toMatchObject({
      reason: 'Paused for review',
      to: { active: false, chain: [] },
    });
  });

  it('propagates changes to other API processes through Redis pub/sub', async () => {
    const other = await buildTestApp({ redis, aiAdapters: anthropic.registry });
    const stop = await other.container.ai.listenForChanges();
    try {
      const before = await other.container.ai.config.get();
      const root = await adminAs(['SUPER_ADMIN']);
      const mock = (await models(root)).find((m) => m.modelId === 'mock-llm')!;
      await root('patch', `/ai/models/${mock.id}`).send({ enabled: false }).expect(200);
      let after = before;
      for (let i = 0; i < 50 && after === before; i++) {
        await new Promise((r) => setTimeout(r, 20));
        after = await other.container.ai.config.get();
      }
      expect(after).not.toBe(before);
      expect(after.models.get(mock.id)!.enabled).toBe(false);
    } finally {
      await stop();
    }
  });
});

describe('models and pricing', () => {
  it('adds effective-dated prices, refusing past dates and mixed currencies', async () => {
    const root = await adminAs(['SUPER_ADMIN']);
    const sonnet = (await models(root)).find((m) => m.modelId === 'claude-sonnet-5')!;
    const future = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
    const res = await root('post', `/ai/models/${sonnet.id}/prices`)
      .send({
        unit: 'PER_1M_OUTPUT_TOKENS',
        price: '12.50',
        effectiveFrom: future,
        reason: 'Announced price change',
      })
      .expect(201);
    const updated = AiModelSummary.parse(res.body.data);
    expect(updated.pricing).toHaveLength(4);
    // Not in force yet.
    expect(
      updated.currentPricing.find((p) => p.unit === 'PER_1M_OUTPUT_TOKENS')!.pricePerUnitMicros,
    ).toBe(10_000_000);

    await root('post', `/ai/models/${sonnet.id}/prices`)
      .send({
        unit: 'PER_1M_OUTPUT_TOKENS',
        price: '1',
        effectiveFrom: '2020-01-01T00:00:00.000Z',
        reason: 'rewrite history',
      })
      .expect(400);
    await root('post', `/ai/models/${sonnet.id}/prices`)
      .send({ unit: 'PER_REQUEST', price: '1', currency: 'INR', reason: 'mixed currency' })
      .expect(400);
  });

  it('validates model parameters and blocks duplicates', async () => {
    const root = await adminAs(['SUPER_ADMIN']);
    const opus = (await models(root)).find((m) => m.modelId === 'claude-opus-5')!;
    await root('patch', `/ai/models/${opus.id}`)
      .send({ params: { retries: 9 } })
      .expect(400);
    const ok = await root('patch', `/ai/models/${opus.id}`)
      .send({ params: { concurrency: 5 } })
      .expect(200);
    expect(ok.body.data.params).toMatchObject({ concurrency: 5, retries: 1, timeoutMs: 120_000 });
    await root('post', '/ai/models')
      .send({
        providerId: opus.providerId,
        modelId: 'claude-opus-5',
        displayName: 'Dup',
        capabilities: ['LLM'],
      })
      .expect(409);
  });

  it('connectivity test calls the model directly and reports the outcome', async () => {
    const root = await adminAs(['SUPER_ADMIN']);
    const all = await models(root);
    const mock = all.find((m) => m.modelId === 'mock-llm')!;
    const ok = await root('post', `/ai/models/${mock.id}/test`).expect(200);
    expect(ok.body.data).toMatchObject({ ok: true, outcome: 'SUCCESS', servedModel: 'mock-llm' });
    const opus = all.find((m) => m.modelId === 'claude-opus-5')!;
    const noKey = await root('post', `/ai/models/${opus.id}/test`).expect(200);
    expect(noKey.body.data).toMatchObject({ ok: false, message: 'Not called: no_credentials' });
    expect(await AiUsageModel.countDocuments({ feature: 'admin.test' })).toBe(1);
  });
});

describe('prompt registry', () => {
  const body = {
    key: 'interview.question',
    feature: 'interview.question',
    messages: [
      { role: 'system', content: 'You interview candidates for {{role}}.' },
      { role: 'user', content: 'Resume:\n{{resume}}' },
    ],
  };

  it('versions prompts, activates one at a time and serves the active version', async () => {
    const content = await adminAs(['CONTENT_ADMIN']);
    const v1 = PromptTemplateSummary.parse(
      (await content('post', '/prompts').send(body).expect(201)).body.data,
    );
    expect(v1).toMatchObject({
      version: 1,
      status: 'DRAFT',
      locale: 'en',
      variables: ['resume', 'role'],
    });
    await content('post', '/prompts').send(body).expect(409);
    await content('post', `/prompts/${v1.id}/activate`)
      .send({ reason: 'First version' })
      .expect(200);
    await content('post', `/prompts/${v1.id}/activate`).send({ reason: 'again' }).expect(409);

    const v2 = PromptTemplateSummary.parse(
      (
        await content('post', '/prompts')
          .send({
            ...body,
            messages: [{ role: 'system', content: 'Interview for {{role}}. Be concise.' }],
          })
          .expect(201)
      ).body.data,
    );
    expect(v2.version).toBe(2);
    expect((await t.container.ai.prompts.getActive('interview.question'))!.version).toBe(1);
    await content('post', `/prompts/${v2.id}/activate`)
      .send({ reason: 'Shorter prompt' })
      .expect(200);
    expect((await t.container.ai.prompts.getActive('interview.question'))!.version).toBe(2);
    // Locales without their own version fall back to English.
    expect((await t.container.ai.prompts.getActive('interview.question', 'te'))!.version).toBe(2);

    const list = z
      .array(PromptTemplateSummary)
      .parse((await content('get', '/prompts').expect(200)).body.data);
    expect(list.map((p) => [p.version, p.status])).toEqual([
      [2, 'ACTIVE'],
      [1, 'RETIRED'],
    ]);
  });

  it('refuses to edit prompt content after creation', async () => {
    const content = await adminAs(['CONTENT_ADMIN']);
    const v1 = (await content('post', '/prompts').send(body).expect(201)).body.data;
    await expect(
      PromptTemplateModel.updateOne(
        { _id: v1.id },
        { $set: { messages: [{ role: 'user', content: 'changed' }] } },
      ),
    ).rejects.toThrow(/immutable/);
    await expect(PromptTemplateModel.deleteOne({ _id: v1.id })).rejects.toThrow();
  });
});

it('aiUsage is append-only', async () => {
  await t.container.ai.router.run('role.analyze', { messages: [{ role: 'user', content: 'x' }] });
  await expect(AiUsageModel.updateOne({}, { $set: { costMicros: 0 } })).rejects.toThrow(
    /append-only/,
  );
  await expect(AiUsageModel.deleteMany({})).rejects.toThrow(/append-only/);
});
