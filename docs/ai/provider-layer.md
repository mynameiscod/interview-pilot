# AI provider layer

How CareerPilot Interview calls AI models (Phase 2). Product code never names a provider or model. It asks for a **feature** (for example `interview.question`), and the router decides which model serves it from configuration that admins change at runtime.

Code: [`packages/ai-core`](../../packages/ai-core) (router, cost, secrets, prompts), [`packages/provider-adapters/src/llm`](../../packages/provider-adapters/src/llm) (OpenAI, Anthropic, Gemini, mock), [`packages/db/src/models/ai.ts`](../../packages/db/src/models/ai.ts) (collections), [`apps/api/src/modules/ai`](../../apps/api/src/modules/ai) (wiring, admin API, boot).

## Making a call

```ts
const result = await container.ai.router.run(
  'interview.assessTurn',
  {
    messages: renderPrompt(template, { role: 'Backend engineer', answer: untrusted(answerText) }),
    output: { name: 'assessment', schema: TurnAssessment }, // optional Zod schema
  },
  {
    sessionId,
    userId,
    correlationId: req.id,
    prompt: { key: template.key, version: template.version },
    signal,
  },
);
result.data; // schema-validated when `output` was given
```

- `AiUnavailableError`: every model in the route failed, was skipped or none is configured. The API maps it to `503 AI_UNAVAILABLE` with a generic message. The attempt trail is logged, never returned. **The router never returns a made-up answer.**
- `AiAbortedError`: the caller's `signal` aborted (for example, the candidate disconnected). There is no fallback.

## Routing, retries and fallback

Each feature has a route: an ordered chain of models (`aiRoutes`). For each model, in priority order, the router:

1. **Skips** it when the model or provider is disabled, the model lacks the feature's capability, the provider has no key or its key cannot be decrypted, no adapter can run in this environment, the circuit is open, or all concurrency slots stay busy for 2 s. Each skip is recorded with its reason.
2. **Calls** it with the model's `timeoutMs`. Transient failures (`TIMEOUT`, `RATE_LIMITED`, `PROVIDER_ERROR`, `NETWORK_ERROR`) are retried up to `retries` times, with full-jitter exponential backoff (250 ms base, 4 s cap). Auth errors, bad requests and refusals move straight to the next model.
3. **Validates** structured output against the Zod schema. An invalid or truncated reply gets **one repair request** (the model sees its reply and the validation problems). If that also fails, the router moves to the next model.

SDK-level retries are disabled in every adapter, so the router is the only thing retrying.

**Concurrency:** a per-model semaphore in Redis (sorted-set leases that expire on their own) caps in-flight calls across all API and worker replicas at the model's `concurrency`.

**Circuit breaker:** 5 counted failures within 60 s open a model's circuit for 30 s. After that, exactly one caller probes it (half-open): success closes the circuit, failure re-opens it. Timeouts, rate limits, 5xx, network and auth errors count. Bad requests and invalid output don't, because the provider did answer. State lives in Redis. It is best-effort by design.

**Redis down:** coordination fails open. Calls continue without the semaphore and breaker, and a warning is logged.

**Anthropic refusal fallback:** for `claude-opus-5*` and `claude-fable-5*`, the adapter also sends `fallbacks: "default"` (beta `server-side-fallback-2026-07-01`). If a safety classifier declines the request, Anthropic re-runs it on its recommended model within the same call. The model that actually answered is stored as `servedModel` in the usage row.

## Configuration changes apply immediately

Admin changes publish on the Redis channel `cbi:ai:config-changed`. Every API process subscribes on a dedicated connection and drops its cached config and prompts. The cache also expires after `AI_CONFIG_CACHE_TTL_SEC` (default 30 s) in case a message is missed. If MongoDB is briefly unreachable during a reload, the last good configuration keeps serving.

## Metering and cost

Every provider call writes one row to `aiUsage` (append-only). This includes failures, retries and repair calls. A row holds the feature, provider, model, `servedModel`, units, latency, attempt number, outcome, error code, context (`sessionId`, `userId`, `correlationId`, prompt key and version), the **price snapshot** in force at call time, and the cost.

- **Money is stored in integer micro-units** (1/1,000,000 of the currency's major unit): `$5.00` is `5_000_000`. A typical call costs a fraction of a cent, so minor units (cents or paise) would round most calls to zero.
- `calculateCost(units, priceSnapshot)` is pure and uses exact BigInt arithmetic. Each line is rounded half-up to the nearest micro-unit.

| Unit                         | Bills                                                                     |
| ---------------------------- | ------------------------------------------------------------------------- |
| `PER_1M_INPUT_TOKENS`        | input tokens, excluding cached ones if a cached price exists              |
| `PER_1M_CACHED_INPUT_TOKENS` | input tokens served from a prompt cache                                   |
| `PER_1M_OUTPUT_TOKENS`       | output tokens (including thinking tokens, which providers bill as output) |
| `PER_MINUTE`                 | session duration                                                          |
| `PER_AUDIO_MINUTE`           | audio duration                                                            |
| `PER_STT_HOUR`               | audio duration                                                            |
| `PER_1M_CHARACTERS`          | characters (TTS)                                                          |
| `PER_IMAGE`, `PER_REQUEST`   | count                                                                     |

- **Prices are effective-dated and append-only.** A change adds an entry with an `effectiveFrom` of now or later. Past dates are refused, so recorded usage is never re-priced. A model is priced in one currency.
- A model with no price in force is still metered, at cost 0, and a warning is logged.
- Anthropic prompt-cache _writes_ are billed by Anthropic at 1.25× the input price. They are metered here at the plain input price until prompt caching is adopted.

The worker rolls `aiUsage` into `providerHealth` every minute (`WORKER_PROVIDER_HEALTH_INTERVAL_MS`). Each row covers one model and one 5-minute window: calls, provider failures, error rate, p50/p95 latency, and a status (`HEALTHY` below 10 % errors, `DEGRADED` below 50 %, `DOWN` otherwise, `IDLE` with no calls). Rows expire after 30 days. `admin.test` calls are excluded.

## Provider keys

- API keys are entered in **Admin → AI providers → Providers & keys**, or imported once from `AI_BOOTSTRAP_{OPENAI,ANTHROPIC,GEMINI}_API_KEY` into providers that have no key yet.
- They are stored with **AES-256-GCM**, using a fresh 96-bit random IV per encryption and the provider (`aiProvider:<key>`) bound as authenticated data, so a ciphertext copied onto another provider fails to decrypt. The master key is `AI_SECRETS_MASTER_KEY` (32 bytes, base64), identified by `AI_SECRETS_KEY_ID`.
- Keys are decrypted in-process for each call and never cached in Redis or written to logs. The API returns and audits only `last4` and the key id. Responses that set a key are sent with `Cache-Control: no-store`.
- Setting, replacing and removing a key requires `ai.manage` (super admin only), plus a reason that is recorded in the audit log.

**Rotating the master key:**

1. Generate a new key: `openssl rand -base64 32`.
2. Set `AI_SECRETS_MASTER_KEY` to the new key and `AI_SECRETS_KEY_ID` to a new id (for example `k2`). Move the old key to `AI_SECRETS_PREVIOUS_KEYS=k1:<old base64>`.
3. Restart the API. At boot it re-encrypts every stored key with the new master key (once, even with several replicas) and audits `ai.provider_credential_rotated`.
4. Once the audit log shows every provider rotated, remove the old key from `AI_SECRETS_PREVIOUS_KEYS`.

If a stored key can't be decrypted (for example, its master key is missing), boot logs an error and the router skips that provider until the key is re-entered.

## The mock provider

`mock` returns deterministic, clearly labelled output. Text replies start with `[mock]`, and structured replies are schema-valid samples whose strings start with `[mock]`. It is registered only when `APP_ENV` is `development` or `test` **and** `AI_MOCK_MODE=true`. Environment validation refuses `AI_MOCK_MODE=true` in staging and production, and the admin console hides mock records wherever the mock can't run.

In development, the seeded routes put the mock **last** (priority 99). Features therefore work without any keys, and a real model serves as soon as its key is added.

The sampler prefers `null` for nullable strings that carry a regex `pattern` (such as resume dates), because it cannot satisfy arbitrary patterns. A unit test in the worker checks that mock output validates for every Phase 3 feature, and that a sampled blueprint normalises into valid `BlueprintContent`.

## Default catalog

At boot the API inserts missing providers, models and routes. It never modifies existing ones, so admin changes always win.

- Providers: Anthropic, OpenAI, Google Gemini (plus the mock in development).
- Models: Claude Opus 5 ($5 / $25 per 1M input/output tokens), Claude Sonnet 5 ($2 / $10) and Claude Haiku 4.5 ($1 / $5), with cached-input prices at 10 %. **Check these against the providers' current price lists before launch.**
- Routes: every LLM feature uses Claude Opus 5, then Claude Sonnet 5 (then the mock in development).
- OpenAI and Gemini models are **not** seeded, because model ids and prices change often. Add them under **Models & pricing**: enter the exact provider model id, add its prices, run **Test**, then add it to routes.

`stt.live`, `tts.live` and `ocr.document` have no adapters yet, so their routes stay empty. The document parser has an OCR hook ready for when an `ocr.document` adapter is added.

## Prompt registry

Prompts are versioned documents in `promptTemplates`, unique on `{key, version, locale}`.

- **Content is immutable.** The model layer rejects any update other than a status change. Editing means creating the next version as a `DRAFT` and activating it. Activating retires the previous `ACTIVE` version, and rolling back means activating an older version. At most one version per key and locale is active (enforced by a partial unique index).
- `ai.prompts.getActive(key, locale)` falls back to English. Callers record `{key, version}` on the usage row, and later on the session.
- `renderPrompt(template, values)` fills in `{{variable}}` placeholders. It fails on missing or unknown variables. Values wrapped in `untrusted(text)` (resumes, JDs, answers) are placed in `<data name="…">` blocks that the text cannot close early, and the system message gains an instruction to treat those blocks as data only.

## Admin console and permissions

| Section                                               | Read            | Change           |
| ----------------------------------------------------- | --------------- | ---------------- |
| AI providers (keys, models, pricing, routing, health) | `ai.read`       | `ai.manage`      |
| AI usage & cost                                       | `ai_usage.read` | —                |
| Prompts                                               | `prompts.read`  | `prompts.manage` |

`ai.manage` belongs to super admins only. Operations can read AI configuration and cost. Finance can read cost only. Content admins manage prompts. Every change is audited with its before/after state and, where the form asks for one, a reason. **Test** on a model sends a small, billed request straight to that model, bypassing routing. It is limited to 10 per minute per admin.

API: `/api/v1/admin/ai/*` and `/api/v1/admin/prompts`. See the OpenAPI document ([`docs/api/openapi.json`](../api/openapi.json), or `/api/docs` in development).

## Not yet built

- Streaming (`LLMProvider.stream`), plus the STT, TTS, OCR, embedding and translation adapters, arrive with the phases that need them.
- Worker-side AI calls now exist (Phase 3: resume/JD structuring, role analysis, blueprint generation). `buildAiRuntime` lives in `@cbi/ai-runtime`, so the worker needs `AI_SECRETS_MASTER_KEY` (and `AI_MOCK_MODE` in development) just like the API. Both subscribe to config-change broadcasts.
- Latency and cost charts. The console shows tables for now (charts are planned for Phase 11 analytics).
- Candidate-facing AI work runs in the background in Phase 3: an unavailable model shows up as a session `failure.code` (`AI_UNAVAILABLE`), which the analysis screen explains in English, Hindi and Telugu. Synchronous `AI_UNAVAILABLE` errors arrive with the live interview in Phase 4.
