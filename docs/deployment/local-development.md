# Local development

## Option A — apps on the host, data stores in Docker (recommended)

```bash
corepack enable
pnpm install
cp .env.example .env
pnpm infra:up
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
pnpm infra:up
MONGODB_URI="mongodb://localhost:27018/cbi_interview_test?directConnection=true" \
REDIS_URL="redis://localhost:6380" \
pnpm test:integration   # fails loudly if services are not reachable
```

## Resetting local data

```bash
docker compose down -v   # removes the mongo-data volume
```

## Troubleshooting

| Symptom                                            | Fix                                                                                      |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `ports are not available` on 27018/6380            | Something else uses the port. Set `CBI_MONGO_HOST_PORT` / `CBI_REDIS_HOST_PORT`          |
| API exits with `Invalid environment configuration` | The message names each invalid variable. Compare `.env` with `.env.example`              |
| `/readyz` returns 503 with `mongo: unreachable`    | Run `docker compose ps`. MongoDB must be `healthy`, which takes about 10 s on first boot |
| `ERR_PNPM_UNSUPPORTED_ENGINE`                      | Use Node.js 24 LTS (`.nvmrc`)                                                            |
