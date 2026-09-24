# End-to-end tests (`@cbi/e2e`)

Playwright suite that drives the **built** apps in real browsers: the compiled API and
worker (AI, storage and code-judge mocks), both SPAs served by `vite preview`, a real
MongoDB replica set, Redis and Mailpit (sign-in codes are read from Mailpit's API).

## Run locally

Prerequisites:

1. The local Docker stack: `corepack pnpm infra:up` (MongoDB on `localhost:27018`, Redis on
   `localhost:6380`, Mailpit SMTP `1025` / API `http://localhost:8025`).
2. A build of the API and worker: `corepack pnpm build`.
3. Browsers, once: `corepack pnpm e2e:install` (Chromium and WebKit; Playwright 1.58 uses
   Chromium build 1208).

Then, from the repository root:

```sh
corepack pnpm e2e                                   # all projects
corepack pnpm e2e --project=desktop-chrome          # one project
corepack pnpm e2e --project=mobile-chrome specs/campaign.spec.ts
corepack pnpm --filter @cbi/e2e e2e:report          # open the last HTML report
```

The suite uses its **own** database (`cbi_interview_e2e`) and Redis DB index (`/13`); it drops
and flushes only those at the start of a run, so the developer data in the Docker stack is not
touched. It refuses to run against a database whose name does not contain `e2e` or against Redis
DB index 0.

### What the global setup does

`support/global-setup.ts`:

1. Drops the e2e database and flushes the e2e Redis index.
2. Rebuilds both SPAs into `tests/e2e/.cache/spa/` with `VITE_API_URL` pointing at the e2e API
   (the API URL is baked into the bundle at build time; the regular `apps/*/dist` builds are
   not touched). The admin build also gets `VITE_CANDIDATE_URL` so invite links are complete.
3. Starts `node apps/api/dist/index.js` and `node apps/worker/dist/index.js` with
   `APP_ENV=development`, `AI_MOCK_MODE=true`, `STORAGE_PROVIDER=local`, `JUDGE_PROVIDER=mock`,
   email via SMTP to Mailpit and SMS disabled, then `vite preview` for each SPA.
4. Waits for `/readyz` on the API and worker and for both SPAs; stops everything afterwards.

Server output goes to `tests/e2e/.cache/logs/` (`api.log`, `worker.log`, …).

All URLs use `localhost`, so the SPAs and the API are the same site and the refresh cookie
(`SameSite=Lax`) works. Before each test the API's rate-limit counters (`cbi:rl:*` in the e2e
Redis index) are cleared, because every browser in the suite shares one IP.

### Environment overrides

| Variable                                  | Default                                                             |
| ----------------------------------------- | ------------------------------------------------------------------- |
| `E2E_MONGODB_URI`                         | `mongodb://localhost:27018/cbi_interview_e2e?directConnection=true` |
| `E2E_REDIS_URL`                           | `redis://localhost:6380/13`                                         |
| `E2E_MAILPIT_URL`                         | `http://localhost:8025`                                             |
| `E2E_SMTP_HOST` / `E2E_SMTP_PORT`         | `127.0.0.1` / `1025`                                                |
| `E2E_API_PORT` / `E2E_WORKER_HEALTH_PORT` | `4971` / `4972`                                                     |
| `E2E_CANDIDATE_PORT` / `E2E_ADMIN_PORT`   | `6273` / `6274`                                                     |
| `E2E_WORKER_TIMEOUT_MS`                   | `240000` (analysis, scoring and PDF waits)                          |
| `E2E_LOG_LEVEL`                           | `warn` (API and worker log level)                                   |
| `E2E_SKIP_SPA_BUILD=1`                    | reuse the SPA builds in `.cache/spa` when their env is unchanged    |

## Matrix

| Project          | Device                  | Notes                                                     |
| ---------------- | ----------------------- | --------------------------------------------------------- |
| `desktop-chrome` | Desktop Chrome          |                                                           |
| `mobile-chrome`  | Pixel 7 (Chromium)      | Admin navigation is opened through its toggle button.     |
| `webkit`         | Desktop Safari (WebKit) | Runs in CI; skipped locally when WebKit is not installed. |

Tests run one at a time (`workers: 1`) against one stack; each test creates its own users
(unique, timestamped emails) and never depends on another test. CI retries a failed test once
and keeps traces and screenshots of failures; the HTML report is written to
`tests/e2e/playwright-report/`.

## Specs

| Spec                       | Covers                                                                                            |
| -------------------------- | ------------------------------------------------------------------------------------------------- |
| `candidate-signup.spec.ts` | Landing → email OTP sign-in (code from Mailpit) → onboarding → dashboard; session survives reload |
| `interview-flow.spec.ts`   | Role-only wizard → analysis → text setup → consents → room (3 answers, end early) → report + PDF  |
| `pricing-i18n.spec.ts`     | Pricing lists plans; switching to Hindi translates the page and is remembered                     |
| `campaign.spec.ts`         | Operations admin creates, activates and copies a campaign invite; a candidate signs up and joins  |
| `admin.spec.ts`            | Analytics KPI tiles; System health dependencies; a finance admin has no System section            |
| `accessibility.spec.ts`    | axe (WCAG 2.1 A/AA) on landing, sign-in, pricing, report, admin dashboard: no serious/critical    |
| `login-next.spec.ts`       | Sign-in returns to `?next=` (known app bug, `test.fixme`)                                         |

Tests marked `test.fixme` document known application defects (see the comments in the spec);
remove the marker once the app is fixed.

## CI

The `e2e` job in `.github/workflows/ci.yml` runs after `verify`, one job per project, with
MongoDB (single-node replica set), Redis and Mailpit containers. It runs `pnpm build`,
installs the browser with `playwright install --with-deps`, runs the suite and uploads the HTML
report, traces and server logs when it fails.
