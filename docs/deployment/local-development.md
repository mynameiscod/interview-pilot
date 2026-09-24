# Local development

## Option A — apps on the host, data stores in Docker (recommended)

```bash
corepack enable
pnpm install
cp .env.example .env
pnpm infra:up   # MongoDB, Redis and the Mailpit inbox
pnpm dev
```

`pnpm dev` runs all four apps with hot reload. Workspace packages are consumed from TypeScript source through the `@cbi/source` export condition, so there's no build step during development.

| Service       | URL                                                             |
| ------------- | --------------------------------------------------------------- |
| API           | http://localhost:4000 (`/healthz`, `/readyz`, `/api/docs`)      |
| Worker health | http://localhost:4100/readyz                                    |
| Candidate app | http://localhost:5173                                           |
| Admin app     | http://localhost:5174                                           |
| MongoDB       | `mongodb://localhost:27018/cbi_interview?directConnection=true` |
| Redis         | `redis://localhost:6380`                                        |
| Mailpit inbox | http://localhost:8025                                           |

`pnpm infra:up` starts MongoDB, Redis and the Mailpit inbox.

### Signing in locally

No real email or SMS is sent in development:

- **Email codes** go to the Mailpit inbox at http://localhost:8025.
- **Mobile codes** (`SMS_PROVIDER=dev-mailbox`) also appear in Mailpit, as messages to `sms-<number>@dev-sms.local` with the subject `[DEV SMS] to +91…`. This provider is refused in staging and production.
- **Google** is off until you set `GOOGLE_CLIENT_ID` (API) and `VITE_GOOGLE_CLIENT_ID` (web apps) to an OAuth _Web_ client id whose authorized JavaScript origins include `http://localhost:5173` and `http://localhost:5174`. No client secret is needed.

### Admin access

Admins cannot sign up. Create the first super admin, then sign in to http://localhost:5174 with that email (the code arrives in Mailpit):

```bash
pnpm --filter @cbi/api admin:seed --email you@codebegun.com
```

In a deployed container: `docker compose exec api node dist/scripts/seed-super-admin.js --email you@codebegun.com`. Further admins are invited from **Admin users** in the console.

### AI providers locally

With `AI_MOCK_MODE=true` (the `.env.example` default), every AI feature is served by the deterministic `mock` provider. Its replies start with `[mock]`, and it sits last in each route. To try a real model, add its API key in the admin console under **AI providers → Providers & keys** (or set `AI_BOOTSTRAP_ANTHROPIC_API_KEY` etc. before first start), then press **Test** on the model. Real calls are billed by the provider. Usage and cost show under **AI usage & cost**. The example `AI_SECRETS_MASTER_KEY` is refused in staging and production. Details: [AI provider layer](../ai/provider-layer.md).

### Uploads and background jobs locally

Resumes and JD files are stored under `.data/storage` in the repository (`STORAGE_PROVIDER=local`, git-ignored). The API and the worker must point at the same folder, so start both with `pnpm dev`. Parsing, JD URL fetching and role analysis run in the **worker**: if the worker is not running, inputs stay "processing" and analysis fails after 3 minutes with `INPUT_TIMEOUT`. In Option B both containers share the `storage-data` volume.

The seeded library (4 roles with blueprints, 2 interview templates) and the Phase 3 prompts are inserted at API start if they are missing. Admins edit them under **Library** and **Prompts** in the console. With the mock provider, analysis produces a clearly labelled `[mock]` plan.

JD links are fetched with the production SSRF policy even locally, so `localhost` and private-network URLs are refused on purpose.

### Why ports 27018 and 6380?

The dev stack avoids the default ports so it can run alongside other local MongoDB/Redis installs. To change them, set `CBI_MONGO_HOST_PORT` / `CBI_REDIS_HOST_PORT` before `pnpm infra:up` and update `.env` to match.

### Why a replica set?

Credit-ledger and payment flows use multi-document transactions, which MongoDB only supports on a replica set. The container initializes a single-node set (`rs0`) on first start. Host connections need `directConnection=true` because the member advertises itself as `localhost:27017` inside the container.

## Option B — everything in containers

```bash
docker compose --profile apps up -d --build
```

| Service       | URL                   |
| ------------- | --------------------- |
| API           | http://localhost:4000 |
| Candidate app | http://localhost:8080 |
| Admin app     | http://localhost:8081 |

These are the production images (non-root, compiled output) running in development configuration.

## Tests

```bash
pnpm test               # unit + component, no services needed
pnpm infra:up   # MongoDB, Redis and the Mailpit inbox
MONGODB_URI="mongodb://localhost:27018/cbi_interview_test?directConnection=true" \
REDIS_URL="redis://localhost:6380" \
pnpm test:integration   # fails loudly if services are not reachable
pnpm build && pnpm smoke:boot   # boots the compiled API and worker under plain Node
```

Integration tests use Redis logical database 15 and wipe it (and the test MongoDB database) between tests, so they never touch your development data. Set `TEST_LOG_LEVEL=error` to see server-side errors while debugging a failing test.

## Resetting local data

```bash
docker compose down -v   # removes the mongo-data volume
```

## Troubleshooting

| Symptom                                            | Fix                                                                                                                 |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `ports are not available` on 27018/6380            | Something else uses the port. Set `CBI_MONGO_HOST_PORT` / `CBI_REDIS_HOST_PORT`                                     |
| API exits with `Invalid environment configuration` | The message names each invalid variable. Compare `.env` with `.env.example`                                         |
| `/readyz` returns 503 with `mongo: unreachable`    | Run `docker compose ps`. MongoDB must be `healthy`, which takes about 10 s on first boot                            |
| `ERR_PNPM_UNSUPPORTED_ENGINE`                      | Use Node.js 24 LTS (`.nvmrc`)                                                                                       |
| `ERR_PNPM_VIRTUAL_STORE_DIR_MAX_LENGTH_DIFF`       | A different pnpm version is on your PATH. Run `corepack enable` (or `corepack pnpm …`) to use the pinned one        |
| AI feature returns `503 AI_UNAVAILABLE`            | Check **AI providers → Routing** and **Health**. The API log line `ai unavailable` lists why each model was skipped |
