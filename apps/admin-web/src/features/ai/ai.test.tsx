import type {
  AdminMeResponse,
  AdminRole,
  AiModelSummary,
  AiProviderSummary,
  AiRouteSummary,
  AiUsageReport,
  Permission,
  PromptTemplateSummary,
} from '@cbi/shared-types';
import { permissionsFor } from '@cbi/shared-types';
import { AuthProvider, createSessionManager } from '@cbi/web-core';
import { fakeApi, makeSession, makeUser, ok } from '@cbi/web-core/testing';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nextProvider } from 'react-i18next';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { describe, expect, it } from 'vitest';
import { routes } from '../../app/routes';
import { loadAdminUser } from '../../app/session';
import { initI18n } from '../../i18n';
import { formatMicros, microsToDecimal, providerName } from './format';

const now = new Date().toISOString();

function adminMe(roles: AdminRole[]): AdminMeResponse {
  return {
    ...makeUser({ id: 'admin-1', email: 'root@codebegun.com', adminRoles: roles }),
    permissions: [...permissionsFor(roles)] as Permission[],
  };
}

const provider = (overrides: Partial<AiProviderSummary> = {}): AiProviderSummary => ({
  id: 'p1',
  key: 'anthropic',
  displayName: 'Anthropic',
  enabled: true,
  available: true,
  credential: null,
  baseUrl: null,
  region: null,
  notes: null,
  updatedAt: now,
  ...overrides,
});

const model = (overrides: Partial<AiModelSummary> = {}): AiModelSummary => ({
  id: 'm1',
  providerId: 'p1',
  providerKey: 'anthropic',
  modelId: 'claude-opus-5',
  displayName: 'Claude Opus 5',
  capabilities: ['LLM'],
  enabled: true,
  languages: [],
  params: {
    temperature: null,
    maxOutputTokens: 16000,
    timeoutMs: 120000,
    retries: 1,
    concurrency: 20,
  },
  pricing: [],
  currentPricing: [
    {
      unit: 'PER_1M_INPUT_TOKENS',
      pricePerUnitMicros: 5_000_000,
      currency: 'USD',
      effectiveFrom: now,
    },
    {
      unit: 'PER_1M_OUTPUT_TOKENS',
      pricePerUnitMicros: 25_000_000,
      currency: 'USD',
      effectiveFrom: now,
    },
  ],
  updatedAt: now,
  ...overrides,
});

async function renderAt(
  path: string,
  roles: AdminRole[],
  handlers: Parameters<typeof fakeApi>[0] = {},
) {
  const api = fakeApi({
    'POST /admin/auth/refresh': () => ok(makeSession()),
    'GET /admin/me': () => ok(adminMe(roles)),
    ...handlers,
  });
  const i18n = await initI18n();
  const manager = createSessionManager({
    baseUrl: 'http://api.test',
    audience: 'admin',
    fetchImpl: api.fetchImpl,
    locks: null,
  });
  render(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <AuthProvider manager={manager} loadUser={loadAdminUser}>
          <RouterProvider router={createMemoryRouter(routes, { initialEntries: [path] })} />
        </AuthProvider>
      </QueryClientProvider>
    </I18nextProvider>,
  );
  return api;
}

describe('money formatting', () => {
  it('shows sub-cent costs instead of rounding them away', () => {
    expect(formatMicros(20_000, 'USD', 'en')).toBe('$0.02');
    expect(formatMicros(14, 'USD', 'en')).toBe('$0.000014');
    expect(formatMicros(5_000_000, 'USD', 'en')).toBe('$5.00');
    expect(microsToDecimal(12_500_000)).toBe('12.5');
    expect(microsToDecimal(1)).toBe('0.000001');
  });
});

describe('AI sections by role', () => {
  it('shows AI configuration to super admins and only cost to finance', async () => {
    await renderAt('/', ['SUPER_ADMIN']);
    const nav = await screen.findByRole('navigation', { name: 'Admin sections' });
    for (const name of ['AI providers', 'AI usage & cost', 'Prompts']) {
      expect(within(nav).getByRole('link', { name })).toBeInTheDocument();
    }
  });

  it('hides provider configuration from finance', async () => {
    await renderAt('/ai', ['FINANCE_ADMIN']);
    expect(
      await screen.findByRole('heading', { name: 'You do not have access to this section' }),
    ).toBeInTheDocument();
    const nav = screen.getByRole('navigation', { name: 'Admin sections' });
    expect(within(nav).getByRole('link', { name: 'AI usage & cost' })).toBeInTheDocument();
    expect(within(nav).queryByRole('link', { name: 'AI providers' })).not.toBeInTheDocument();
  });

  it('lets operations view providers without management controls', async () => {
    await renderAt('/ai', ['OPERATIONS_ADMIN'], {
      'GET /admin/ai/providers': () => ok([provider()]),
    });
    expect(await screen.findByText('No key')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add key' })).not.toBeInTheDocument();
  });
});

describe('provider keys', () => {
  it('sends the key with a reason, then shows only the last 4 characters', async () => {
    let stored: AiProviderSummary = provider();
    const api = await renderAt('/ai', ['SUPER_ADMIN'], {
      'GET /admin/ai/providers': () => ok([stored]),
      'PUT /admin/ai/providers/p1/credential': () => {
        stored = provider({ credential: { last4: 'abcd', keyId: 'k1', updatedAt: now } });
        return ok(stored);
      },
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Add key' }));
    const keyInput = screen.getByLabelText('Anthropic API key');
    expect(keyInput).toHaveAttribute('type', 'password');
    await user.type(keyInput, 'sk-ant-secret-abcd');
    const save = screen.getByRole('button', { name: 'Save key' });
    expect(save).toBeDisabled();
    await user.type(screen.getByLabelText('Reason (recorded in the audit log)'), 'Production key');
    await user.click(save);
    expect(await screen.findByText('Key ending abcd')).toBeInTheDocument();
    expect(api.calls.find((c) => c.key === 'PUT /admin/ai/providers/p1/credential')!.body).toEqual({
      apiKey: 'sk-ant-secret-abcd',
      reason: 'Production key',
    });
    expect(screen.queryByDisplayValue('sk-ant-secret-abcd')).not.toBeInTheDocument();
  });
});

describe('models', () => {
  it('shows prices in force and runs a connectivity test', async () => {
    await renderAt('/ai/models', ['SUPER_ADMIN'], {
      'GET /admin/ai/models': () => ok([model()]),
      'POST /admin/ai/models/m1/test': () =>
        ok({
          ok: true,
          outcome: 'SUCCESS',
          latencyMs: 812,
          servedModel: 'claude-opus-5',
          sample: 'OK',
          message: null,
        }),
    });
    expect(await screen.findByText('Input $5.00 / 1M tokens')).toBeInTheDocument();
    expect(screen.getByText('Output $25.00 / 1M tokens')).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Test' }));
    expect(
      await screen.findByText('Connected in 812 ms (claude-opus-5): “OK”'),
    ).toBeInTheDocument();
  });

  it('adds a price as a decimal string with a reason', async () => {
    const api = await renderAt('/ai/models', ['SUPER_ADMIN'], {
      'GET /admin/ai/models': () => ok([model()]),
      'POST /admin/ai/models/m1/prices': () => ({ status: 201, body: { data: model() } }),
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Add price' }));
    await user.selectOptions(screen.getByLabelText('Pricing unit'), 'PER_1M_OUTPUT_TOKENS');
    await user.type(screen.getByLabelText('Price (USD)'), '20');
    await user.type(
      screen.getByLabelText('Reason (recorded in the audit log)'),
      'Provider price cut',
    );
    await user.click(screen.getAllByRole('button', { name: 'Add price' }).at(-1)!);
    await screen.findByRole('button', { name: 'Test' });
    expect(api.calls.find((c) => c.key === 'POST /admin/ai/models/m1/prices')!.body).toEqual({
      unit: 'PER_1M_OUTPUT_TOKENS',
      price: '20',
      currency: 'USD',
      reason: 'Provider price cut',
    });
  });
});

describe('routing', () => {
  it('reorders a fallback chain and saves it with priorities', async () => {
    const route: AiRouteSummary = {
      feature: 'interview.question',
      capability: 'LLM',
      active: true,
      chain: [
        { modelId: 'm1', priority: 0, label: 'Claude Opus 5 (Anthropic)' },
        { modelId: 'm2', priority: 1, label: 'Claude Sonnet 5 (Anthropic)' },
      ],
      updatedAt: now,
    };
    const api = await renderAt('/ai/routes', ['SUPER_ADMIN'], {
      'GET /admin/ai/routes': () => ok([route]),
      'GET /admin/ai/models': () =>
        ok([
          model(),
          model({ id: 'm2', modelId: 'claude-sonnet-5', displayName: 'Claude Sonnet 5' }),
        ]),
      'PUT /admin/ai/routes/interview.question': () => ok(route),
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Edit' }));
    await user.click(screen.getByRole('button', { name: 'Move Claude Sonnet 5 (Anthropic) up' }));
    await user.type(
      screen.getByLabelText('Reason (recorded in the audit log)'),
      'Faster first answer',
    );
    await user.click(screen.getByRole('button', { name: 'Save route' }));
    await screen.findByRole('button', { name: 'Edit' });
    expect(
      api.calls.find((c) => c.key === 'PUT /admin/ai/routes/interview.question')!.body,
    ).toEqual({
      active: true,
      chain: [
        { modelId: 'm2', priority: 0 },
        { modelId: 'm1', priority: 1 },
      ],
      reason: 'Faster first answer',
    });
  });
});

describe('usage & cost', () => {
  it('renders totals and breakdown with micro-unit costs', async () => {
    const row = {
      key: 'interview.question',
      calls: 3,
      failures: 1,
      inputTokens: 4000,
      outputTokens: 800,
      costMicros: { USD: 20_014 },
      avgLatencyMs: 950,
    };
    const report: AiUsageReport = {
      from: now,
      to: now,
      groupBy: 'feature',
      rows: [row],
      totals: { ...row, key: 'total' },
    };
    await renderAt('/ai-usage', ['FINANCE_ADMIN'], {
      'GET /admin/ai/usage': () => ok(report),
      'GET /admin/ai/usage/entries': () => ok({ items: [], nextCursor: null }),
    });
    expect(await screen.findByRole('heading', { name: 'AI usage & cost' })).toBeInTheDocument();
    expect(await screen.findAllByText('$0.02')).toHaveLength(2);
    expect(screen.getByText('4,000 in · 800 out')).toBeInTheDocument();
    expect(screen.getByText('No AI calls in this period.')).toBeInTheDocument();
  });
});

describe('voice (speech models)', () => {
  const tts = (overrides: Partial<AiModelSummary> = {}) =>
    model({
      id: 'tts1',
      providerId: 'p-el',
      providerKey: 'elevenlabs',
      modelId: 'eleven_flash_v2_5',
      displayName: 'ElevenLabs Flash v2.5',
      capabilities: ['TTS'],
      params: {
        temperature: null,
        maxOutputTokens: 4096,
        timeoutMs: 15000,
        retries: 1,
        concurrency: 20,
        voice: null,
      },
      currentPricing: [
        {
          unit: 'PER_1M_CHARACTERS',
          pricePerUnitMicros: 50_000_000,
          currency: 'USD',
          effectiveFrom: now,
        },
      ],
      ...overrides,
    });
  const stt = model({
    id: 'stt1',
    providerId: 'p-dg',
    providerKey: 'deepgram',
    modelId: 'nova-3',
    displayName: 'Deepgram Nova-3',
    capabilities: ['STT'],
    currentPricing: [
      { unit: 'PER_STT_HOUR', pricePerUnitMicros: 460_000, currency: 'USD', effectiveFrom: now },
    ],
  });

  it('names providers by key, never by an i18n path', async () => {
    const i18n = await initI18n();
    expect(providerName(i18n.t, 'deepgram')).toBe('Deepgram');
    expect(providerName(i18n.t, 'elevenlabs')).toBe('ElevenLabs');
    expect(providerName(i18n.t, 'acme')).toBe('Acme');
  });

  it('labels new providers by name, with key hints', async () => {
    await renderAt('/ai', ['SUPER_ADMIN'], {
      'GET /admin/ai/providers': () =>
        ok([
          provider({ id: 'p-dg', key: 'deepgram', displayName: 'Deepgram' }),
          provider({ id: 'p-el', key: 'elevenlabs', displayName: '' }),
        ]),
    });
    expect(await screen.findByText('Deepgram')).toBeInTheDocument();
    // A blank display name falls back to the key's label, not the raw key.
    expect(screen.getByText('ElevenLabs')).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getAllByRole('button', { name: 'Add key' })[1]!);
    expect(screen.getByLabelText('ElevenLabs API key')).toBeInTheDocument();
    expect(screen.getByText(/elevenlabs\.io → Developers → API keys/)).toBeInTheDocument();
  });

  it('shows speech prices in their own units and the test sample', async () => {
    await renderAt('/ai/models', ['SUPER_ADMIN'], {
      'GET /admin/ai/models': () => ok([tts(), stt]),
      'POST /admin/ai/models/tts1/test': () =>
        ok({
          ok: true,
          outcome: 'SUCCESS',
          latencyMs: 300,
          servedModel: 'eleven_flash_v2_5',
          sample: '12345 bytes of audio/mpeg',
          message: null,
        }),
    });
    expect(await screen.findByText('$50.00 per 1M characters')).toBeInTheDocument();
    expect(screen.getByText('$0.46 per STT hour')).toBeInTheDocument();
    // Token prices are not listed for speech-only models.
    expect(screen.queryByText(/\/ 1M tokens/)).not.toBeInTheDocument();
    expect(screen.getByText('Provider default voice')).toBeInTheDocument();
    await userEvent.setup().click(screen.getAllByRole('button', { name: 'Test' })[0]!);
    expect(
      await screen.findByText(
        'Connected in 300 ms (eleven_flash_v2_5): “12345 bytes of audio/mpeg”',
      ),
    ).toBeInTheDocument();
  });

  it('edits the voice id of a TTS model and sends null when blank', async () => {
    const api = await renderAt('/ai/models', ['SUPER_ADMIN'], {
      'GET /admin/ai/models': () => ok([tts({ params: { ...tts().params, voice: 'old-voice' } })]),
      'PATCH /admin/ai/models/tts1': () => ok(tts()),
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Edit limits' }));
    const voice = screen.getByLabelText('Voice ID');
    expect(voice).toHaveValue('old-voice');
    expect(screen.queryByLabelText('Max output tokens')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Temperature')).not.toBeInTheDocument();
    await user.clear(voice);
    await user.type(voice, '  EXAVITQu4vr4xnSDxMaL ');
    await user.click(screen.getByRole('button', { name: 'Save limits' }));
    await screen.findByRole('button', { name: 'Edit limits' });
    const patches = () => api.calls.filter((c) => c.key === 'PATCH /admin/ai/models/tts1');
    expect(patches()[0]!.body).toMatchObject({ params: { voice: 'EXAVITQu4vr4xnSDxMaL' } });

    await user.click(screen.getByRole('button', { name: 'Edit limits' }));
    await user.clear(screen.getByLabelText('Voice ID'));
    await user.click(screen.getByRole('button', { name: 'Save limits' }));
    await screen.findByRole('button', { name: 'Edit limits' });
    expect(patches()[1]!.body).toMatchObject({ params: { voice: null } });
  });

  it('does not offer a voice for text models', async () => {
    const api = await renderAt('/ai/models', ['SUPER_ADMIN'], {
      'GET /admin/ai/models': () => ok([model()]),
      'PATCH /admin/ai/models/m1': () => ok(model()),
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Edit limits' }));
    expect(screen.queryByLabelText('Voice ID')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Max output tokens')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save limits' }));
    await screen.findByRole('button', { name: 'Edit limits' });
    const body = api.calls.find((c) => c.key === 'PATCH /admin/ai/models/m1')!.body as {
      params: Record<string, unknown>;
    };
    expect(body.params).not.toHaveProperty('voice');
  });

  it('creates a TTS model with its voice (null when blank)', async () => {
    const api = await renderAt('/ai/models', ['SUPER_ADMIN'], {
      'GET /admin/ai/models': () => ok([]),
      'GET /admin/ai/providers': () =>
        ok([provider(), provider({ id: 'p-el', key: 'elevenlabs', displayName: 'ElevenLabs' })]),
      'POST /admin/ai/models': () => ({ status: 201, body: { data: tts() } }),
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Add model' }));
    expect(screen.queryByLabelText('Voice ID')).not.toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Provider'), 'p-el');
    // ElevenLabs suggests the TTS capability, which brings up the voice field.
    expect(screen.getByLabelText('Text to speech (TTS)')).toBeChecked();
    expect(screen.getByLabelText('Text generation (LLM)')).not.toBeChecked();
    expect(screen.getByLabelText('Voice ID')).toHaveValue('');
    await user.type(screen.getByLabelText('Provider model id'), 'eleven_flash_v2_5');
    await user.type(screen.getByLabelText('Display name'), 'ElevenLabs Flash');
    await user.click(screen.getAllByRole('button', { name: 'Add model' }).at(-1)!);
    await screen.findByRole('button', { name: 'Add model' });
    expect(api.calls.find((c) => c.key === 'POST /admin/ai/models')!.body).toEqual({
      providerId: 'p-el',
      modelId: 'eleven_flash_v2_5',
      displayName: 'ElevenLabs Flash',
      capabilities: ['TTS'],
      params: { voice: null },
    });
  });

  it('offers only TTS models in the tts.live chain editor', async () => {
    const route: AiRouteSummary = {
      feature: 'tts.live',
      capability: 'TTS',
      active: true,
      chain: [],
      updatedAt: null,
    };
    await renderAt('/ai/routes', ['SUPER_ADMIN'], {
      'GET /admin/ai/routes': () => ok([route]),
      'GET /admin/ai/models': () =>
        ok([
          model(),
          stt,
          tts(),
          tts({
            id: 'tts2',
            providerKey: 'openai',
            modelId: 'gpt-4o-mini-tts',
            displayName: 'GPT-4o mini TTS',
          }),
        ]),
    });
    expect(await screen.findByText('Text to speech (live interviews)')).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Edit' }));
    const options = within(screen.getByLabelText('Add a model…'))
      .getAllByRole('option')
      .map((o) => o.textContent);
    expect(options).toEqual([
      'Add a model…',
      'ElevenLabs Flash v2.5 (ElevenLabs)',
      'GPT-4o mini TTS (OpenAI)',
    ]);
  });
});

describe('prompts', () => {
  const prompt = (overrides: Partial<PromptTemplateSummary> = {}): PromptTemplateSummary => ({
    id: 'v1',
    key: 'interview.question',
    version: 1,
    locale: 'en',
    feature: 'interview.question',
    status: 'DRAFT',
    messages: [{ role: 'system', content: 'Interview for {{role}}.' }],
    variables: ['role'],
    notes: null,
    contentHash: 'abcdef1234567890',
    createdAt: now,
    activatedAt: null,
    ...overrides,
  });

  it('activates a draft with a reason; content admins cannot see AI provider settings', async () => {
    const api = await renderAt('/prompts', ['CONTENT_ADMIN'], {
      'GET /admin/prompts': () => ok([prompt()]),
      'POST /admin/prompts/v1/activate': () => ok(prompt({ status: 'ACTIVE' })),
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Activate' }));
    await user.type(screen.getByLabelText('Reason (recorded in the audit log)'), 'Reviewed');
    await user.click(screen.getByRole('button', { name: 'Activate v1' }));
    await screen.findByRole('button', { name: 'Activate' });
    expect(api.calls.find((c) => c.key === 'POST /admin/prompts/v1/activate')!.body).toEqual({
      reason: 'Reviewed',
    });
    const nav = screen.getByRole('navigation', { name: 'Admin sections' });
    expect(within(nav).queryByRole('link', { name: 'AI providers' })).not.toBeInTheDocument();
  });

  it('starts a new version from an existing one', async () => {
    const api = await renderAt('/prompts', ['CONTENT_ADMIN'], {
      'GET /admin/prompts': () => ok([prompt({ status: 'ACTIVE' })]),
      'POST /admin/prompts': () => ({
        status: 201,
        body: { data: prompt({ id: 'v2', version: 2 }) },
      }),
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'New version' }));
    const system = screen.getByLabelText('System instructions');
    expect(system).toHaveValue('Interview for {{role}}.');
    await user.type(screen.getByLabelText('User message'), 'Ask one question.');
    await user.click(screen.getByRole('button', { name: 'Save as draft' }));
    await screen.findByRole('button', { name: 'New prompt' });
    expect(api.calls.find((c) => c.key === 'POST /admin/prompts')!.body).toMatchObject({
      key: 'interview.question',
      locale: 'en',
      feature: 'interview.question',
      messages: [
        { role: 'system', content: 'Interview for {{role}}.' },
        { role: 'user', content: 'Ask one question.' },
      ],
      notes: null,
    });
  });
});
