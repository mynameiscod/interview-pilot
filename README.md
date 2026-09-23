# CareerPilot Interview — by CodeBegun

AI interview readiness and assessment platform. Candidates add a resume and job description, take a realistic AI interview, and receive an evidence-backed readiness report and improvement plan. CodeBegun admins can run concierge employer hiring campaigns on the same engine.

| Surface       | Production URL                        |
| ------------- | ------------------------------------- |
| Candidate app | https://interview.codebegun.com       |
| Admin app     | https://admin.interview.codebegun.com |
| API           | https://api.interview.codebegun.com   |

This is a standalone product. It shares no database or code with other CodeBegun products; future integrations (CareerPilot, employer products, CodeBegun Judge) go through APIs.

## Status

| Phase                          | Status                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **0 — Foundation**             | Done: monorepo, typed config, structured logging, API/worker with health, readiness and graceful shutdown, design tokens, i18n (English, Telugu, Hindi), Docker images, CI                                                                                                                                                                                                                 |
| **1 — Authentication & users** | Done: email/mobile OTP and Google sign-in, rotating refresh tokens with replay detection, account linking, onboarding, admin roles and permissions, admin user management, append-only audit log. See [docs/security/authentication.md](docs/security/authentication.md)                                                                                                                   |
| **2 — AI provider layer**      | Done: feature-based routing with fallback chains, retries, circuit breaker and concurrency limits; OpenAI, Anthropic, Gemini and dev-only mock adapters; encrypted provider keys with rotation; per-call usage metering with price snapshots; versioned prompt registry; admin AI providers, usage & cost, and prompts screens. See [docs/ai/provider-layer.md](docs/ai/provider-layer.md) |
| 3 — Inputs & roles             | Next                                                                                                                                                                                                                                                                                                                                                                                       |

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
  provider-adapters/   Email (SES, SMTP), SMS (MSG91) and LLM (OpenAI, Anthropic, Gemini, mock) adapters; storage, payments later
  design-system/       Design tokens, Bootstrap theme, brand components
  web-core/            Browser API client, session manager, auth context, shared sign-in UI
infrastructure/
  docker/              Dockerfiles and the static SPA server config
  scripts/             brand-check, boot-smoke (deploy/backup in Phase 12)
docs/                  Architecture, API (OpenAPI), deployment, product, security
```

Packages for later phases (`interview-engine`, `scoring-core`) are created in the phase that implements them, not as empty stubs.

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
