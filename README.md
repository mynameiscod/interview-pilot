# CareerPilot Interview — by CodeBegun

AI interview readiness and assessment platform. Candidates add a resume and job description, take a realistic AI interview, and receive an evidence-backed readiness report and improvement plan. CodeBegun admins can run concierge employer hiring campaigns on the same engine.

| Surface       | Production URL                        |
| ------------- | ------------------------------------- |
| Candidate app | https://interview.codebegun.com       |
| Admin app     | https://admin.interview.codebegun.com |
| API           | https://api.interview.codebegun.com   |

This is a standalone product. It shares no database or code with other CodeBegun products; future integrations (CareerPilot, employer products, CodeBegun Judge) go through APIs.

## Status

| Phase                           | Status                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **0 — Foundation**              | Done: monorepo, typed config, structured logging, API/worker with health, readiness and graceful shutdown, design tokens, i18n (English, Telugu, Hindi), Docker images, CI                                                                                                                                                                                                                                                                                                                                                                                |
| **1 — Authentication & users**  | Done: email/mobile OTP and Google sign-in, rotating refresh tokens with replay detection, account linking, onboarding, admin roles and permissions, admin user management, append-only audit log. See [docs/security/authentication.md](docs/security/authentication.md)                                                                                                                                                                                                                                                                                  |
| **2 — AI provider layer**       | Done: feature-based routing with fallback chains, retries, circuit breaker and concurrency limits; OpenAI, Anthropic, Gemini and dev-only mock adapters; encrypted provider keys with rotation; per-call usage metering with price snapshots; versioned prompt registry; admin AI providers, usage & cost, and prompts screens. See [docs/ai/provider-layer.md](docs/ai/provider-layer.md)                                                                                                                                                                |
| **3 — Inputs & roles**          | Done: resume and JD upload (type sniffing, zip-bomb and page limits), JD paste and SSRF-guarded URL fetching, AI structuring with raw-text fallback, role analysis with canonical or tailored blueprints, versioned role/blueprint/template library, companies with verified patterns, candidate wizard, analysis and setup screens, admin library screens. See [docs/architecture/inputs-and-role-analysis.md](docs/architecture/inputs-and-role-analysis.md) and [docs/security/uploads-and-url-fetching.md](docs/security/uploads-and-url-fetching.md) |
| **4 — Interview engine (text)** | Done: pure session state machine (exhaustively tested), question planner with follow-ups, probes and adaptive difficulty, question ledger, Socket.IO room with reconnect and resume, worker sweep for pauses and expiry, credit ledger with the free credit and reserve/consume/refund, text interview room. See [docs/architecture/live-interview.md](docs/architecture/live-interview.md)                                                                                                                                                               |
| **5 — Evaluation & reports**    | Done: staged evaluation pipeline (evidence extraction, per-dimension scoring, deterministic aggregation and confidence with an evidence guard, recommendations, report, PDF, email) with fallbacks and re-runs, report, history and compare screens, feedback, AI evaluation fixture suite and regression runner. See [docs/architecture/evaluation-and-reports.md](docs/architecture/evaluation-and-reports.md) and [docs/ai/evaluation-regression.md](docs/ai/evaluation-regression.md)                                                                 |
| **6 — Payments**                | Done: versioned plans, coupons, server-side pricing, Razorpay orders with Checkout verification (signature and captured amount), signed and idempotent webhooks, credits issued exactly once across verify/webhook/reconciliation, hourly reconciliation, full refunds that withdraw unused credits, pricing, checkout, payment status and purchase history screens, admin plans, coupons and payments screens. See [docs/architecture/payments.md](docs/architecture/payments.md)                                                                        |
| **7 — Voice**                   | Done: speech-to-text and text-to-speech through the AI router (Deepgram, OpenAI, ElevenLabs and dev mocks) with fallback and metering, device check and voice consent before start, spoken questions (cached), recorded answers transcribed and reviewed before submitting, degrade-to-text and back, voice room, admin speech models and voices. See [docs/architecture/voice.md](docs/architecture/voice.md)                                                                                                                                            |
| **8 — Video, consent & media**  | Done: video interviews (voice pipeline + camera), versioned consent texts with an append-only consent record, optional recording uploaded in 10 s segments that never affect the interview (retries, idempotent segments, PARTIAL recordings, worker finalization), signed playback, candidate deletion and admin purge, integrity observations shown neutrally (never scored), automatic retention cleanup, admin recordings and consent text screens. See [docs/architecture/media-and-consent.md](docs/architecture/media-and-consent.md)              |
| **9 — Coding**                  | Done: judge adapter with HMAC-signed requests (CodeBegun Judge, interim Judge0 on a separate host, dev mock that never executes code), versioned problem bank with server-side hidden tests, coding rounds with an editor, autosave, run and submit, judge-down handling that never breaks the interview, judged evidence merged into evaluation and coding results in reports, admin problem bank. See [docs/architecture/coding.md](docs/architecture/coding.md)                                                                                        |
| 10 — Campaigns & review         | Next                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

The full design and phase plan: [docs/architecture/00-mvp-design-proposal.md](docs/architecture/00-mvp-design-proposal.md).

> **Release blocker:** official brand assets aren't supplied yet. See [docs/product/brand-assets-required.md](docs/product/brand-assets-required.md).

## Repository layout

```text
apps/
  api/             Express 5 REST API (+ Socket.IO from Phase 4)
  worker/          BullMQ background workers
  candidate-web/   React + Vite + Bootstrap 5 candidate app
  admin-web/       React + Vite + Bootstrap 5 admin console
packages/
  shared-types/        Zod schemas + TS contracts shared by every app (incl. the permission matrix)
  config/              Typed env loading, structured logging, readiness checks
  db/                  MongoDB/Redis connectivity, Mongoose models, index management
  auth-core/           Access tokens, OTP/refresh-token crypto, email/phone normalization
  ai-core/             AI router (fallback, retries, circuit breaker), cost calculator, secret box, prompt rendering
  interview-engine/    Pure interview state machine, question planner, clock and usage rules (no I/O)
  scoring-core/        Pure scoring: weights, evidence guard, aggregation, confidence, readiness bands
  ai-runtime/          Wires the AI router for a process (adapters, secrets, MongoDB config/metering, Redis cache busting)
  documents/           Untrusted document handling: type sniffing, zip-bomb checks, bounded PDF/DOCX/text extraction
  provider-adapters/   Email (SES, SMTP), SMS (MSG91), LLM (OpenAI, Anthropic, Gemini, mock), object storage (Bunny, local) and the SSRF-guarded fetcher
  design-system/       Design tokens, Bootstrap theme, brand components
  web-core/            Browser API client, session manager, auth context, shared sign-in UI
infrastructure/
  docker/              Dockerfiles and the static SPA server config
  scripts/             brand-check, boot-smoke (deploy/backup in Phase 12)
docs/                  Architecture, API (OpenAPI), deployment, product, security
```

Packages for later phases are created in the phase that implements them, not as empty stubs.

## Quick start

Prerequisites: Node.js 24 LTS (≥ 24.11), Docker Desktop, and Corepack (ships with Node).

```bash
corepack enable
pnpm install
cp .env.example .env
pnpm infra:up      # MongoDB (replica set) :27018, Redis :6380, Mailpit inbox :8025
pnpm --filter @cbi/api admin:seed --email you@codebegun.com   # first super admin
pnpm dev           # API :4000, worker, candidate app :5173, admin app :5174
```

- Candidate app: http://localhost:5173 · Admin console: http://localhost:5174
- Sign-in codes (email and dev SMS) arrive in the local inbox: http://localhost:8025
- API docs (dev only): http://localhost:4000/api/docs · readiness: http://localhost:4000/readyz

More detail, including the fully containerized stack, is in [docs/deployment/local-development.md](docs/deployment/local-development.md).

## Common commands

| Command                             | Purpose                                                                 |
| ----------------------------------- | ----------------------------------------------------------------------- |
| `pnpm lint` / `pnpm typecheck`      | Static checks across the workspace                                      |
| `pnpm test`                         | Unit and component tests (no external services)                         |
| `pnpm test:integration`             | Integration tests against real MongoDB + Redis (`pnpm infra:up` first)  |
| `pnpm build`                        | Production builds                                                       |
| `pnpm format` / `pnpm format:check` | Prettier                                                                |
| `pnpm openapi:generate`             | Regenerate `docs/api/openapi.json` from the Zod contracts               |
| `pnpm smoke:boot`                   | Boots the compiled API and worker under plain Node (after `pnpm build`) |
| `pnpm brand:check`                  | Release gate: fails while official brand assets are missing             |

## Engineering rules

- Contracts live in `packages/shared-types` (Zod). The API, web apps and OpenAPI document are all derived from them.
- No secrets in the repository, in `VITE_*` variables or in logs. The logger redacts credential fields.
- No raw colour values in components; use `var(--cb-*)` tokens. ESLint enforces this.
- No UI strings in components; use i18n keys.
- Mocks exist only in tests and in clearly labelled local-development providers.
