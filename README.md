# CareerPilot Interview — by CodeBegun

AI interview readiness and assessment platform. Candidates add a resume and job description, take a realistic AI interview, and receive an evidence-backed readiness report and improvement plan. CodeBegun admins can run concierge employer hiring campaigns on the same engine.

| Surface       | Production URL                        |
| ------------- | ------------------------------------- |
| Candidate app | https://interview.codebegun.com       |
| Admin app     | https://admin.interview.codebegun.com |
| API           | https://api.interview.codebegun.com   |

This is a standalone product. It shares no database or code with other CodeBegun products; future integrations (CareerPilot, employer products, CodeBegun Judge) go through APIs.

## Status

**Phase 0 — Foundation** is complete: monorepo, typed configuration, structured logging, API and worker skeletons with health/readiness and graceful shutdown, design tokens, i18n (English, Telugu, Hindi), both web app shells, Docker images, local Docker stack and CI. See [docs/architecture/00-mvp-design-proposal.md](docs/architecture/00-mvp-design-proposal.md) for the full design and phase plan.

> **Release blocker:** official brand assets aren't supplied yet. See [docs/product/brand-assets-required.md](docs/product/brand-assets-required.md).

## Repository layout

```text
apps/
  api/             Express 5 REST API (+ Socket.IO from Phase 4)
  worker/          BullMQ background workers
  candidate-web/   React + Vite + Bootstrap 5 candidate app
  admin-web/       React + Vite + Bootstrap 5 admin console
packages/
  shared-types/    Zod schemas + TS contracts shared by every app
  config/          Typed env loading, structured logging, readiness checks
  db/              MongoDB/Redis connectivity (models and migrations from Phase 1)
  design-system/   Design tokens, Bootstrap theme, brand components
infrastructure/
  docker/          Dockerfiles and the static SPA server config
  scripts/         Operational scripts (brand-check; deploy/backup in Phase 12)
docs/              Architecture, API (OpenAPI), deployment, product, security
```

Packages for later phases (`interview-engine`, `ai-core`, `provider-adapters`, `scoring-core`, `auth-core`) are created in the phase that implements them, not as empty stubs.

## Quick start

Prerequisites: Node.js 24 LTS (≥ 24.11), Docker Desktop, and Corepack (ships with Node).

```bash
corepack enable
pnpm install
cp .env.example .env
pnpm infra:up      # MongoDB (single-node replica set) on :27018, Redis on :6380
pnpm dev           # API :4000, worker, candidate app :5173, admin app :5174
```

- API liveness: http://localhost:4000/healthz · readiness: http://localhost:4000/readyz
- API docs (dev only): http://localhost:4000/api/docs

More detail, including the fully containerized stack, is in [docs/deployment/local-development.md](docs/deployment/local-development.md).

## Common commands

| Command                             | Purpose                                                                |
| ----------------------------------- | ---------------------------------------------------------------------- |
| `pnpm lint` / `pnpm typecheck`      | Static checks across the workspace                                     |
| `pnpm test`                         | Unit and component tests (no external services)                        |
| `pnpm test:integration`             | Integration tests against real MongoDB + Redis (`pnpm infra:up` first) |
| `pnpm build`                        | Production builds                                                      |
| `pnpm format` / `pnpm format:check` | Prettier                                                               |
| `pnpm openapi:generate`             | Regenerate `docs/api/openapi.json` from the Zod contracts              |
| `pnpm brand:check`                  | Release gate: fails while official brand assets are missing            |

## Engineering rules

- Contracts live in `packages/shared-types` (Zod). The API, web apps and OpenAPI document are all derived from them.
- No secrets in the repository, in `VITE_*` variables or in logs. The logger redacts credential fields.
- No raw colour values in components; use `var(--cb-*)` tokens. ESLint enforces this.
- No UI strings in components; use i18n keys.
- Mocks exist only in tests and in clearly labelled local-development providers.
