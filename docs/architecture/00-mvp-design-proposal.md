# CodeBegun AI Interview Platform — MVP Design Proposal

Status: **APPROVED 2026-09-23.** Phase 0 (Foundation) implemented. See the decision log in §17.
Date: 2026-09-23

---

## 0. Repository inspection result

| Check                                             | Finding                                                       |
| ------------------------------------------------- | ------------------------------------------------------------- |
| Files                                             | None. The working tree is empty apart from `.git`.            |
| Commits                                           | None. `main` has no commits yet.                              |
| Remote                                            | `origin → https://github.com/mynameiscod/interview-pilot.git` |
| README / config / env / deployment files          | None exist.                                                   |
| Brand assets (logo, CodeBegun System Style Guide) | **Not present.** These must be supplied (see §15).            |

Conclusion: this is a greenfield repository. Everything below is a proposal. Nothing gets scaffolded until it's approved.

> **Note:** the implementation brief was cut off at §89 ("GRACEFU…", which is probably graceful shutdown/draining). Sections 89 onward have not been received. This proposal covers §1–§88. Some sections below may need to change once the rest arrives.

---

## 1. Key architectural decisions (summary)

| #   | Decision             | Recommendation                                                                                                                                                                                                                                      | Why                                                                                                                                                                                                                                                                                                      |
| --- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Monorepo tooling     | **pnpm workspaces + Turborepo**                                                                                                                                                                                                                     | Fast, strict dependency isolation, cached task pipeline for CI.                                                                                                                                                                                                                                          |
| D2  | Runtime              | **Node.js 24 LTS** (Active LTS). Move to Node 26 after it enters LTS (Oct 2026) and dependencies are verified                                                                                                                                       | Latest active LTS today.                                                                                                                                                                                                                                                                                 |
| D3  | MongoDB topology     | **Single-node replica set** locally and in initial production (Mongo 8.x)                                                                                                                                                                           | Multi-document transactions are needed for the credit ledger, payments and consumption. Transactions require a replica set.                                                                                                                                                                              |
| D4  | Voice architecture   | **Cascaded pipeline controlled by our engine**: streaming STT → orchestrator/LLM → streaming TTS. `RealtimeConversationProvider` remains a pluggable option                                                                                         | The interview engine must own question selection, the ledger and time budget. Speech-to-speech realtime models own the conversation, which conflicts with §20/§29. The cascade is also cheaper, auditable and provider-agnostic. Cost: about 1.5–3 s turn latency, which is acceptable for an interview. |
| D5  | Media storage        | **Bunny Storage (private zone) + Bunny Pull Zone with token authentication** for signed playback                                                                                                                                                    | Bunny Storage has no presigned upload URLs, so chunk uploads go through the API (streamed and never buffered to disk) and then on to Bunny.                                                                                                                                                              |
| D6  | Refresh tokens       | httpOnly, Secure, SameSite=Lax cookie on `api.interview.codebegun.com`, path-scoped to `/api/v1/auth`. Access token is kept in memory only                                                                                                          | Satisfies §9. The candidate and admin apps are same-site (the `codebegun.com` eTLD+1), so cookies work cross-subdomain without `SameSite=None`.                                                                                                                                                          |
| D7  | CSRF                 | Refresh and logout endpoints require the `Origin` allowlist **and** a custom header (`X-CB-CSRF: 1`). Every other endpoint uses a Bearer access token, so no cookie auth is involved                                                                | Cookie-bearing endpoints are the only CSRF surface.                                                                                                                                                                                                                                                      |
| D8  | Socket.IO scaling    | `@socket.io/redis-adapter`, **WebSocket transport first** with polling fallback, NGINX `ip_hash` for polling stickiness                                                                                                                             | Allows horizontal API replicas.                                                                                                                                                                                                                                                                          |
| D9  | Code execution       | **Never on the interview VPS.** `JudgeAdapter`, HMAC-signed requests to an external judge. Interim: self-hosted Judge0-compatible service on a **separate** VPS until CodeBegun Judge exists                                                        | §35/§84.                                                                                                                                                                                                                                                                                                 |
| D10 | PDF rendering        | Playwright Chromium in a dedicated `pdf` queue in the worker (concurrency 2), rendering the same report HTML/Bootstrap templates                                                                                                                    | Brand fidelity, and it reuses the report components. The heavy work is isolated in the worker.                                                                                                                                                                                                           |
| D11 | Document parsing     | `unpdf`/pdf.js for PDF, `mammoth` for DOCX, run in the **worker** with size, page and decompression limits                                                                                                                                          | Untrusted files stay out of API processes.                                                                                                                                                                                                                                                               |
| D12 | JD URL fetch         | `undici` with a custom DNS `lookup` that rejects private/reserved IPs **and pins the connection to the vetted IP** (defeats DNS rebinding). Every redirect hop is re-validated. Readable text is extracted with `@mozilla/readability` + `linkedom` | §13 SSRF rules.                                                                                                                                                                                                                                                                                          |
| D13 | Charts               | Chart.js via `react-chartjs-2`, lazy-loaded                                                                                                                                                                                                         | Light, accessible fallback tables, Bootstrap-compatible.                                                                                                                                                                                                                                                 |
| D14 | Validation contracts | Zod schemas live in `packages/shared-types`. They are the single source for API DTOs, frontend forms and OpenAPI generation (`zod-to-openapi`)                                                                                                      | Prevents contract drift (§6).                                                                                                                                                                                                                                                                            |

Decisions **D3, D4, D5 and D9** need explicit sign-off (see §17).

---

## 2. System architecture

```text
                    ┌────────────────── Browser ──────────────────┐
                    │ candidate-web (React/Vite)  admin-web (React)│
                    └──────┬──────────── HTTPS / WSS ─────────┬────┘
                           ▼                                   ▼
                        NGINX (TLS, HTTP/2, rate-limit L1, static SPA hosting)
                           │
             ┌─────────────┴──────────────┐
             ▼                            ▼
      api (Express + Socket.IO)   api (replica, blue/green)
      - REST /api/v1                     │
      - Socket.IO /rt  ◄── redis adapter ┤
      - interview orchestrator (live turns)
             │            │                     │
             ▼            ▼                     ▼
          MongoDB       Redis ◄──── BullMQ ──► worker(s)
       (source of     (cache, locks,          - parsing / OCR
        truth, RS)     presence, queues,      - blueprint gen
                       rate limits)           - evaluation pipeline
                                              - pdf, email, cleanup
                                              - provider health
             │                                   │
             └──────────── outbound only ────────┘
                  ▼            ▼          ▼          ▼          ▼
               AI providers  Bunny     Razorpay   Judge API   Email/SMS
               (OpenAI,      Storage +            (separate   (SES/SMTP,
               Anthropic,    Pull Zone             host)       MSG91)
               Gemini,
               Deepgram,
               ElevenLabs)
```

**Responsibilities**

- **api**: stateless HTTP and WebSocket. It runs _live_ interview turns because they are latency-sensitive: STT stream in, next question out. It enqueues everything slow.
- **worker**: all asynchronous and long jobs (§70). Scales independently. Separate queues with separate concurrency: `parse`, `ai`, `evaluation`, `pdf`, `notify`, `maintenance`.
- **MongoDB**: the only source of truth (§22).
- **Redis**: active-session cache, presence, distributed locks (turn processing, credit reserve), rate-limit counters, Socket.IO adapter, BullMQ. It's safe to lose: every important write goes to Mongo first.

---

## 3. Repository structure

```text
/
├── apps/
│   ├── candidate-web/         React + Vite + Bootstrap 5 (interview.codebegun.com)
│   │   └── src/{routes,features,components,i18n,lib,media,styles}
│   ├── admin-web/             React + Vite (admin.interview.codebegun.com)
│   ├── api/                   Express + Socket.IO
│   │   └── src/{modules/<domain>/{routes,controller,service,repo,schemas},
│   │            realtime, middleware, plugins, openapi, bootstrap}
│   └── worker/                BullMQ processors
│       └── src/{queues,processors,schedulers}
│
├── packages/
│   ├── shared-types/          Zod schemas + inferred TS types, enums, API envelopes, WS event contracts
│   ├── config/                eslint, tsconfig, prettier, vitest presets; typed env loader (Zod)
│   ├── design-system/         CSS tokens (SCSS over Bootstrap), React primitives, logo slot, icons
│   ├── db/                    Mongoose models, indexes, migrations (migrate-mongo), seeders
│   ├── auth-core/             JWT, refresh-rotation, OTP, RBAC permission matrix
│   ├── ai-core/               Provider interfaces, router/fallback, prompt registry, structured-output validation, usage metering, cost calculator
│   ├── provider-adapters/     openai, anthropic, gemini, deepgram, elevenlabs, mock; msg91, ses/smtp; bunny; razorpay; judge
│   ├── interview-engine/      Pure, deterministic state machine + planner (no I/O)
│   └── scoring-core/          Pure deterministic aggregation, confidence, rubric math
│
├── infrastructure/
│   ├── docker/                Dockerfiles (multi-stage, non-root, distroless/alpine)
│   ├── nginx/                 site configs, security headers, ws upgrade, rate zones
│   ├── scripts/               deploy, backup, restore, rotate-keys, seed-admin
│   └── monitoring/            health probes, log rotation, (future) Grafana/Sentry
├── docs/{architecture,api,database,deployment,ai,security,product}
├── tests/
│   ├── e2e/                   Playwright (desktop Chrome, mobile viewport, WebKit)
│   ├── load/                  k6 (HTTP + WS + queue)
│   └── ai-eval/               fixture library + regression runner (§78)
├── .github/workflows/         ci.yml, deploy-staging.yml, deploy-production.yml
├── docker-compose.yml
├── docker-compose.production.yml
├── .env.example
└── README.md
```

Additions to the brief's shape: `packages/db`, which keeps models shared by api and worker, and `tests/ai-eval`.

---

## 4. MongoDB data model

Conventions: `_id: ObjectId`, `createdAt/updatedAt` on everything, and `schemaVersion` on versioned documents. Money is stored as **integer minor units (paise)** plus `currency`. No binaries in Mongo (§12). The tables list key fields only. Full JSON schemas go into `docs/database/` in Phase 0.

### 4.1 Identity & access

| Collection       | Key fields                                                                                                                                   | Indexes                                                                                |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `users`          | type (`CANDIDATE`/`ADMIN`), roles[], status, primaryEmail, primaryMobile, emailVerifiedAt, mobileVerifiedAt, locale, deletedAt, tokenVersion | unique sparse `primaryEmail`; unique sparse `primaryMobile`; `{type,status,createdAt}` |
| `userProfiles`   | userId, displayName, experienceLevel, currentRole, preferredInterviewLanguage, consentPreferences                                            | unique `userId`                                                                        |
| `authIdentities` | userId, provider (`GOOGLE`/`EMAIL`/`MOBILE`), providerSubject (normalized), verifiedAt                                                       | **unique `{provider, providerSubject}`**; `userId`                                     |
| `refreshTokens`  | userId, familyId, tokenHash (SHA-256), audience (`candidate`/`admin`), parentId, usedAt, revokedAt, expiresAt, device/UA/ip hash             | unique `tokenHash`; `{familyId}`; `{userId, revokedAt}`; **TTL `expiresAt`**           |
| `otpChallenges`  | channel, destinationHash, codeHash (argon2/HMAC), attempts, maxAttempts, purpose, expiresAt, consumedAt                                      | `{destinationHash, purpose, createdAt}`; **TTL `expiresAt`**                           |

Account linking: when a user signs in with a new verified identity whose email or mobile matches an existing verified identity, the identity is attached to that user. It is never auto-linked from an _unverified_ claim. Google's `email_verified=true` counts as verified.

Refresh rotation: each refresh marks the old token `usedAt` and issues a child in the same family. **If a used token is presented again, the whole family is revoked** (replay protection). Logout-all increments `users.tokenVersion` and revokes all families.

### 4.2 Inputs, roles and templates

| Collection           | Key fields                                                                                                                                                                                                           | Indexes                                                                           |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `resumes`            | userId, storageKey (Bunny), originalName, mime, size, sha256, rawText (capped at about 200 KB), structured (normalized schema), extraction {status, version, parser, ocrUsed, warnings}                              | `{userId, createdAt:-1}`; `{userId, sha256}`                                      |
| `jobTargets`         | userId, source (`PASTE`/`UPLOAD`/`URL`/`ROLE_ONLY`), url, fetchStatus, rawText, structured JD, companyId?, roleId?, roleTitle                                                                                        | `{userId, createdAt:-1}`                                                          |
| `companies`          | name, slug, description, roleFamilies[], verifiedPatterns[] {note, sourceType, verifiedBy, verifiedAt}, allowedQuestionCategories[], active                                                                          | unique `slug`; text index `name`                                                  |
| `roles`              | canonical title, slug, family, aliases[], activeBlueprintId, active                                                                                                                                                  | unique `slug`; `{family, active}`; text `title, aliases`                          |
| `roleBlueprints`     | roleId?, origin (`CANONICAL`/`AI_GENERATED`), version, status (`DRAFT`/`ACTIVE`/`RETIRED`), content (full §15 schema), companyOverlay?, generatedBy {model, promptVersion}, sourceJobTargetId, contentHash           | unique `{roleId, version}` (partial on roleId); `{origin, status}`; `contentHash` |
| `interviewTemplates` | name, version, status, mode, rounds[] {type, durationSec, questionCount, difficulty, followUpDepth, minEvidence}, totals {min,max}, codingRequired, proctoringPolicy, scoringPolicy {dimensionWeights}, reportPolicy | unique `{key, version}`                                                           |

**Immutability:** `roleBlueprints`, `interviewTemplates`, `consentTexts`, `promptTemplates`, `scoringPolicies` and `reportTemplates` are **append-only by version**. Editing creates a new version, and sessions reference the exact version `_id` (§59).

Additional versioned collections: `consentTexts`, `promptTemplates`, `scoringPolicies`, `reportTemplates`. Each has unique `{key, version, locale}`.

### 4.3 Interview runtime

| Collection               | Key fields                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Indexes                                                                                                                                                          |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `interviewSessions`      | userId, campaignId?, jobTargetId, resumeId?, **snapshot refs** {blueprintId, templateId, scoringPolicyId, promptVersions{}, consentTextIds[]}, mode, language {preferred, detected}, state, stateVersion (optimistic lock), stateHistory (last 50; full history in `auditLogs`), timing {startedAt, activeMs, budgetMs, pausedAt}, planner {currentRoundIdx, coverage map, remaining competencies}, creditReservationId, processing {stage, status, attempts, error}, failure? | `{userId, createdAt:-1}`; `{state, updatedAt}`; `{campaignId, state}`; partial unique `{userId}` where `state ∈ active states` (**one live interview per user**) |
| `interviewRounds`        | sessionId, idx, type, state, competencyTargets[], budgetMs, usedMs, startedAt, endedAt                                                                                                                                                                                                                                                                                                                                                                                         | unique `{sessionId, idx}`                                                                                                                                        |
| `interviewTurns`         | sessionId, roundId, seq, **question ledger** (§29 fields: questionId, competency, subCompetency, difficulty, source, objective, expectedEvidence[], followUpOf, followUpDepth, askedAt, answeredAt, language), answer {text, originalTranscript, detectedLang, normalizedText?, audioRef?, durationMs}, turnEval {sufficiency, followUpNeeded, notes} (internal, never sent to candidate live)                                                                                 | unique `{sessionId, seq}`; `{sessionId, roundId}`; unique `questionId`                                                                                           |
| `interviewEvidence`      | sessionId, competency, claim, evidenceSource, questionId, turnRef, codingAttemptId?, strength (-2..+2), confidence (0–1), positiveEvidence[], negativeEvidence[], uncertainty, extractorVersion                                                                                                                                                                                                                                                                                | `{sessionId, competency}`                                                                                                                                        |
| `interviewScores`        | sessionId, **revision** (0 = AI original), dimensions[] {key, score, weight, confidence, evidenceIds[]}, overall (deterministic), confidenceLevel, scoringPolicyId, createdBy (`AI`/adminId), reason                                                                                                                                                                                                                                                                           | unique `{sessionId, revision}`                                                                                                                                   |
| `interviewReports`       | sessionId, userId, revision, reportTemplateId, content (structured), pdf {storageKey, status}, visibility {candidate, campaign}, generatedAt                                                                                                                                                                                                                                                                                                                                   | unique `{sessionId, revision}`; `{userId, generatedAt:-1}`                                                                                                       |
| `codingAttempts`         | sessionId, roundId, problemId, language, code (≤ 64 KB), autosavedAt, submissions[] {judgeToken, status, results, runtime}, final                                                                                                                                                                                                                                                                                                                                              | `{sessionId}`; `judgeToken`                                                                                                                                      |
| `proctoringEvents`       | sessionId, type (§37 enum), at, meta                                                                                                                                                                                                                                                                                                                                                                                                                                           | `{sessionId, at}`                                                                                                                                                |
| `mediaAssets`            | sessionId, userId, kind (`CANDIDATE_VIDEO`/`AUDIO`/`SCREEN`), segments[] {idx, storageKey, size, sha256, uploadedAt}, mime, durationMs, consentId, retentionExpiresAt, deletion {status, deletedAt}                                                                                                                                                                                                                                                                            | `{sessionId}`; `{retentionExpiresAt, 'deletion.status'}` (cleanup job)                                                                                           |
| `consents`               | userId, sessionId?, campaignId?, consentType, consentTextId, consentVersion, accepted, acceptedAt, ipHash, userAgent                                                                                                                                                                                                                                                                                                                                                           | `{userId, consentType}`; `{sessionId}`                                                                                                                           |
| `problems` (coding bank) | title, statement, languages[], visibleTests[], hiddenTestsRef, limits, difficulty, tags                                                                                                                                                                                                                                                                                                                                                                                        | `{tags, difficulty}`                                                                                                                                             |

**Size discipline:** turns, evidence and events are separate collections, so no document grows unbounded (the 16 MB limit). The session keeps only a compact planner state.

### 4.4 Commerce

| Collection          | Key fields                                                                                                                                                          | Indexes                                                                            |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `plans`             | code, name, version, priceMinor, currency, credits, validityDays, active, displayOrder, features[]                                                                  | unique `{code, version}`                                                           |
| `coupons`           | code, type (`PERCENT`/`FIXED`), value, validFrom/To, maxUses, perUserLimit, usedCount, planCodes[], active                                                          | unique `code`                                                                      |
| `couponRedemptions` | couponId, userId, purchaseId                                                                                                                                        | unique `purchaseId`; `{couponId, userId}`                                          |
| `purchases`         | userId, planId (+ snapshot of price/credits/validity), couponId?, amountMinor, status (`CREATED`/`PAID`/`FAILED`/`REFUNDED`), creditsIssuedAt, idempotencyKey       | unique `idempotencyKey`; `{userId, createdAt:-1}`                                  |
| `payments`          | purchaseId, razorpayOrderId, razorpayPaymentId, status, statusHistory[], signatureVerified, raw (redacted)                                                          | unique `razorpayOrderId`; unique sparse `razorpayPaymentId`                        |
| `webhookEvents`     | provider, eventId, type, receivedAt, processedAt, result                                                                                                            | **unique `{provider, eventId}`** (idempotency); TTL 180 days                       |
| `creditLedger`      | userId, type (§48 enum), amount (±), **lotId** (grant lot this entry draws from or creates), expiresAt (for grants), refType/refId, idempotencyKey, actorId, reason | **unique `idempotencyKey`**; `{userId, createdAt}`; `{lotId}`; `{type, expiresAt}` |
| `creditAccounts`    | userId, balance, reserved, lots[] {lotId, remaining, expiresAt, source}, version                                                                                    | unique `userId`                                                                    |

Credit model: the ledger is **immutable and authoritative**. `creditAccounts` is a materialized projection updated **in the same Mongo transaction** as the ledger insert. It can always be rebuilt from the ledger by an admin "recompute" tool. Reservation draws from the earliest-expiring lot. `INTERVIEW_RESERVE` → `INTERVIEW_CONSUME` or `INTERVIEW_REFUND`, keyed by `sessionId`, so consumption happens exactly once.

### 4.5 Employer, AI, ops

| Collection                     | Key fields                                                                                                                                                                                                                                                                 | Indexes                                                                              |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `campaigns`                    | companyId, name, roleBlueprintId, templateId, jobTargetSnapshot, window {start,end}, maxCandidates, publicToken (random 32 bytes, stored hashed), languageRules, proctoringPolicy, codingRequired, reportVisibility, candidateFeedbackVisibility, sponsoredCredits, status | unique `publicTokenHash`; `{status, 'window.end'}`                                   |
| `campaignApplications`         | campaignId, userId, joinedAt, consentIds[], sessionId?, status, adminNotes                                                                                                                                                                                                 | **unique `{campaignId, userId}`**; `{campaignId, status}`                            |
| `aiProviders`                  | key (`openai`, …), displayName, enabled, credentials {ciphertext, iv, tag, keyId, last4}, region, baseUrl?, notes                                                                                                                                                          | unique `key`                                                                         |
| `aiModels`                     | providerId, modelId, capabilities[] (`LLM`/`STT`/`TTS`/`REALTIME`/`EMBEDDING`/`OCR`/`TRANSLATION`), enabled, languages[], params {temperature, maxOutput, timeoutMs, retries, concurrency}, **pricing[]** {unit, pricePerUnit, currency, effectiveFrom}                    | unique `{providerId, modelId}`                                                       |
| `aiRoutes`                     | feature (e.g. `interview.question`, `evaluation.score`, `stt.live`), chain[] {modelId, priority}, active                                                                                                                                                                   | unique `feature`                                                                     |
| `aiUsage`                      | provider, model, feature, sessionId?, userId?, units {inputTokens, outputTokens, audioSec, chars, requests}, latencyMs, retries, outcome, errorCode, **priceSnapshot**, costMinor, currency, correlationId                                                                 | `{sessionId}`; `{createdAt}`; `{provider, model, createdAt}`; `{feature, createdAt}` |
| `providerHealth`               | provider, model, window, p50/p95 latency, errorRate, status                                                                                                                                                                                                                | `{provider, model, window}`; TTL 30 days                                             |
| `notifications`                | userId, channel, template, status, providerMessageId, attempts                                                                                                                                                                                                             | `{userId, createdAt}`; TTL 180 days                                                  |
| `feedback`                     | userId, sessionId, ratings {usefulness, accuracy, interviewQuality}, freeText, intendsRetake                                                                                                                                                                               | unique `{sessionId, userId}`                                                         |
| `analyticsEvents`              | name (§56 enum), userId?, anonId, sessionId?, props, at                                                                                                                                                                                                                    | `{name, at}`; `{userId, at}`; TTL configurable (default 400 days)                    |
| `analyticsDaily`               | date, metric, dims, value (rollups for the dashboard)                                                                                                                                                                                                                      | unique `{date, metric, dimsHash}`                                                    |
| `auditLogs`                    | actorId, actorType, action, resourceType, resourceId, before/after (redacted diff), ip, requestId, at                                                                                                                                                                      | `{resourceType, resourceId, at}`; `{actorId, at}`. **No TTL; append-only.**          |
| `reviewRevisions`              | sessionId, target (`SCORE`/`REPORT`/`EVIDENCE`), fromRevision, toRevision, reviewerId, reason                                                                                                                                                                              | `{sessionId}`                                                                        |
| `shareLinks` (feature-flagged) | reportId, userId, tokenHash, expiresAt, revokedAt, views[]                                                                                                                                                                                                                 | unique `tokenHash`; TTL `expiresAt`                                                  |
| `featureFlags`                 | key, enabled, rules                                                                                                                                                                                                                                                        | unique `key`                                                                         |
| `systemSettings`               | key, value, updatedBy                                                                                                                                                                                                                                                      | unique `key`                                                                         |
| `languages`                    | code, uiEnabled, interviewEnabled, providerSupport {stt[], tts[], llm[]}                                                                                                                                                                                                   | unique `code`                                                                        |

Analytics (`analyticsEvents`) and audit (`auditLogs`) are separate collections with separate retention (§56).

---

## 5. API map (`/api/v1`)

Envelope: `{ data, meta? }` on success and `{ error: { code, message, details?, requestId } }` on failure. Error codes are stable enums from `shared-types`. Every candidate-scoped repository query takes the `userId` from the token, never from the client (IDOR, §61).

| Group                   | Endpoints (abridged)                                                                                                                                                                                                                                                                                                                                                                   | Auth / rate class                              |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `/auth`                 | `POST google` · `POST otp/request` · `POST otp/verify` · `POST refresh` · `POST logout` · `POST logout-all` · `POST link/{email,mobile}`                                                                                                                                                                                                                                               | public / `auth`, `otp`                         |
| `/users`                | `GET me` · `PATCH me/profile` · `GET me/consents` · `POST me/deletion-request` · `GET me/export`                                                                                                                                                                                                                                                                                       | candidate                                      |
| `/resumes`              | `POST` (multipart) · `GET` · `GET :id` · `DELETE :id` · `GET :id/status`                                                                                                                                                                                                                                                                                                               | candidate / `upload`                           |
| `/jobs`                 | `POST` (paste/upload/url/role-only) · `GET :id` · `GET :id/status`                                                                                                                                                                                                                                                                                                                     | candidate / `jdUrl`                            |
| `/companies`, `/roles`  | `GET` search (public read of active entries)                                                                                                                                                                                                                                                                                                                                           | public                                         |
| `/interviews`           | `POST` (create draft from jobTarget + resume + template) · `GET` · `GET :id` · `POST :id/analyze` · `POST :id/device-check` · `POST :id/consent` · `POST :id/start` · `POST :id/end` · `POST :id/report-problem`                                                                                                                                                                       | candidate / `ai`                               |
| `/interviews/:id/media` | `POST segments` (chunk upload) · `POST finalize` · `GET playback-url`                                                                                                                                                                                                                                                                                                                  | candidate                                      |
| `/coding`               | `GET problems/:id` · `PUT attempts/:id` (autosave) · `POST attempts/:id/run` · `POST attempts/:id/submit` · `GET attempts/:id`                                                                                                                                                                                                                                                         | candidate / `ai`                               |
| `/reports`              | `GET :sessionId` · `GET :sessionId/pdf` (signed redirect) · `GET compare?sessions=` · `POST :id/share` _(flagged)_                                                                                                                                                                                                                                                                     | candidate / `reports`                          |
| `/plans`, `/credits`    | `GET plans` · `GET credits/balance` · `GET credits/ledger`                                                                                                                                                                                                                                                                                                                             | public / candidate                             |
| `/payments`             | `POST orders` · `POST verify` · `GET history` · `POST webhooks/razorpay` (raw body, signature)                                                                                                                                                                                                                                                                                         | candidate / `payment`; webhook: signature only |
| `/feedback`             | `POST`                                                                                                                                                                                                                                                                                                                                                                                 | candidate                                      |
| `/campaigns`            | `GET :publicToken` · `POST :publicToken/join`                                                                                                                                                                                                                                                                                                                                          | public / candidate                             |
| `/analytics`            | `POST events` (batched, allowlisted names)                                                                                                                                                                                                                                                                                                                                             | public / `public`                              |
| `/admin/*`              | `dashboard`, `candidates`, `interviews` (+ `/:id/transcript`, `/recordings`, `/evidence`, `/review`), `roles`, `blueprints`, `companies`, `templates`, `campaigns` (+ `/results`, `/export.csv`, `/package`), `ai/providers`, `ai/models`, `ai/routes`, `ai/usage`, `plans`, `payments`, `coupons`, `languages`, `media`, `feedback`, `audit`, `system/{flags,settings,health,queues}` | admin RBAC / `admin`                           |
| ops                     | `GET /healthz` (liveness) · `GET /readyz` (Mongo, Redis, queue reachability) · `GET /api/docs` (Swagger, disabled or protected in prod)                                                                                                                                                                                                                                                | internal                                       |

**Admin RBAC matrix (abridged)**

| Permission                                 | SUPER | OPS  | CONTENT | SUPPORT     | FINANCE |
| ------------------------------------------ | ----- | ---- | ------- | ----------- | ------- |
| AI providers & secrets                     | ✔     | –    | –       | –           | –       |
| Roles / blueprints / companies / templates | ✔     | ✔    | ✔       | –           | –       |
| Campaigns & results                        | ✔     | ✔    | –       | read        | –       |
| Candidates, interviews, transcripts        | ✔     | ✔    | –       | ✔           | –       |
| Recordings playback                        | ✔     | ✔    | –       | ✔ (audited) | –       |
| Plans, coupons, payments, refunds          | ✔     | –    | –       | read        | ✔       |
| Credit adjustments                         | ✔     | –    | –       | ✔ (capped)  | ✔       |
| Feature flags, system settings             | ✔     | –    | –       | –           | –       |
| Audit log                                  | ✔     | read | –       | –           | read    |

Every admin mutation passes through an `audit()` middleware that writes redacted before/after state.

### 5.1 Socket.IO events (`/rt` namespace; auth = access token in the handshake)

| Direction | Event                                                                     | Payload (abridged)                                               |
| --------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| C→S       | `interview:join`                                                          | sessionId, lastSeq. The server rehydrates and returns a snapshot |
| S→C       | `interview:state`                                                         | state, round, progress, remainingMs, currentQuestion             |
| S→C       | `interview:question`                                                      | questionId, text, audio stream ref (voice), allowRepeat          |
| C→S       | `answer:text`                                                             | questionId, text, clientMsgId (idempotent)                       |
| C→S       | `answer:audio:start` / `answer:audio:chunk` (binary) / `answer:audio:end` | questionId, codec, seq                                           |
| S→C       | `stt:partial` / `stt:final`                                               | live captions                                                    |
| S→C       | `tts:chunk` / `tts:end`                                                   | audio for the question                                           |
| C→S       | `question:repeat`                                                         | questionId                                                       |
| C→S       | `integrity:event`                                                         | type, at                                                         |
| C→S       | `presence:heartbeat`                                                      | every 10 s                                                       |
| S→C       | `interview:degraded`                                                      | reason, offer (`SWITCH_TO_TEXT`)                                 |
| C→S       | `interview:mode-switch`                                                   | to: `TEXT`                                                       |
| S→C       | `round:transition`, `interview:completed`, `interview:error`              | …                                                                |

All client events carry `clientMsgId`. The server deduplicates them in Redis (60 s window) and via unique Mongo indexes.

---

## 6. Interview state machine

### 6.1 Session states

```text
DRAFT ──analyze──▶ ROLE_ANALYSIS ──ok──▶ READY ──▶ DEVICE_CHECK ──▶ CONSENT_REQUIRED ──▶ READY_TO_START
   │                    │fail                         (skipped for TEXT)   (skipped if no recording)
   │                    ▼                                                          │ start (reserve credit)
   │                 FAILED                                                        ▼
   │                                           ┌────────────── ACTIVE ◀────────────┐
   │                                           │  round done      │ disconnect      │ resume
   │                                           ▼                  ▼                 │
   │                                  ROUND_TRANSITION      RECONNECTING ──────────┘
   │                                           │                  │ grace expired (default 10 min)
   │                                           ▼                  ▼
   │                                  ACTIVE / COMPLETING       PAUSED ──resume──▶ ACTIVE
   │                                           │                  │ resume window expired (default 24 h)
   │                                           ▼                  ▼
   │                                      PROCESSING           EXPIRED ─▶ PROCESSING (if meaningful) / refund
   │                                           │
   │                                           ▼
   └──cancel (pre-start)──▶ CANCELLED     REPORT_READY
                                     (FAILED reachable from any active state on unrecoverable error)
```

- Transitions are a **pure table in `interview-engine`**: `(state, event, context) → (newState, effects[])`. It's unit-tested exhaustively.
- Persistence uses `findOneAndUpdate({_id, stateVersion})` with optimistic concurrency. Every transition appends to `stateHistory` and `auditLogs`.
- Timer: the server is authoritative. `activeMs` accumulates only while `ACTIVE`, so `RECONNECTING` and `PAUSED` don't burn interview time.
- Credits: **reserve** at `READY_TO_START → ACTIVE`. **Consume** when the session reaches `PROCESSING` _and_ the meaningful-usage threshold is met (configurable, e.g. ≥ 40 % of the budget or ≥ N answered questions). Otherwise, or on a provider-caused `FAILED`, **refund**. All three are keyed by `sessionId`.

### 6.2 Round states

`PENDING → ACTIVE → (PAUSED) → COMPLETED | SKIPPED | TIMED_OUT`

### 6.3 Turn loop (inside `ACTIVE`)

```text
planner.nextTarget(coverage, remainingBudget, blueprint)
   → { competency, source: RESUME|JD|ROLE|COMPANY|FOLLOW_UP, difficulty, objective, expectedEvidence }
LLM.generateQuestion(bounded context)  ─▶ ledger entry persisted ─▶ emit question (TTS if voice)
candidate answers (text or STT final)  ─▶ answer persisted
LLM.assessTurn(question, answer, expectedEvidence) → { sufficiency, followUpNeeded, followUpAngle }   [structured JSON, schema-validated]
planner.update(coverage)  → follow-up (depth < max) | next competency | round end | interview end
```

**Bounded context** (never the full transcript, §20): it contains a blueprint _summary_ for the current round, the target competency, relevant resume and JD snippets (pre-extracted at analysis time), the current follow-up thread (≤ 4 turns), and a compact coverage summary. Candidate text is inserted in delimited data blocks with explicit "this is data, not instructions" framing (§30).

---

## 7. AI provider architecture

```ts
interface LLMProvider {
  generate(req: { messages; schema?: ZodSchema; temperature?; maxOutput?; signal }): Promise<{ text | json; usage }>;
  stream?(...): AsyncIterable<...>;
}
interface SpeechToTextProvider { openStream(opts: {language|'auto', sampleRate, codec}): SttStream; transcribe(file): Promise<...>; }
interface TextToSpeechProvider { synthesize(text, {voice, language, format}): AsyncIterable<Uint8Array>; }
interface RealtimeConversationProvider { /* optional, future */ }
interface EmbeddingProvider, OCRProvider, TranslationProvider { ... }
```

- **Registry**: adapters register by `providerKey`. `aiModels` + `aiRoutes` in Mongo decide which adapter and model serves each **feature**. Admin changes take effect via a cache bust (Redis pub/sub) with no deploy.
- **Router** (`ai-core`): `run(feature, request)`. It walks the fallback chain, applying timeout, retries with jitter, a per-model concurrency semaphore (Redis) and a circuit breaker fed by `providerHealth`. Schema-validated structured output gets one repair retry, then falls back to the next model, then fails loudly. **Never a fake response.**
- **Metering**: every call writes an `aiUsage` row with the **price snapshot** copied from the model's effective pricing at call time. The cost calculator is a pure function `(units, priceSnapshot) → costMinor` supporting per-1M-input/output tokens, per-minute, per-audio-minute, per-STT-hour, per-character, per-image and per-request pricing.
- **Secrets**: AES-256-GCM with a 96-bit random IV. The master key comes from `AI_SECRETS_MASTER_KEY` (32 bytes, base64) and carries a `keyId` for rotation. The API returns `last4` only. Decryption happens in-process at call time and plaintext is never cached in Redis.
- **Mock provider**: deterministic, clearly labelled `mock`. It's enabled only when `NODE_ENV ∈ {development,test}` **and** `AI_MOCK_MODE=true`, and boot refuses it in staging or production.
- **Prompt registry**: prompts are versioned documents (`promptTemplates`). Each session stores the versions it used (§59).
- **Voice failover**: an STT/TTS failure during a live turn retries the fallback provider first. If the chain is exhausted, the server emits `interview:degraded` offering `SWITCH_TO_TEXT`. State is preserved and the candidate is informed.

Initial feature routes: `role.analyze`, `resume.structure`, `jd.structure`, `blueprint.generate`, `interview.question`, `interview.assessTurn`, `evaluation.extractEvidence`, `evaluation.scoreDimension`, `report.recommendations`, `stt.live`, `tts.live`, `ocr.document`.

---

## 8. Evaluation pipeline (worker, §71)

```text
PROCESSING
 1 finalize-transcript      (idempotent: marks turns final, computes coverage)
 2 extract-evidence         (per round, parallel; output → interviewEvidence; keyed {sessionId, roundId, extractorVersion})
 3 merge-coding-evidence    (judge results → evidence)
 4 score-dimensions         (LLM per dimension, given ONLY normalized evidence + rubric → 0–100 + rationale + evidenceIds)
 5 aggregate                (scoring-core: deterministic weighted overall; pure function, unit tested)
 6 confidence               (scoring-core: f(independent questions, practical evidence, consistency, completeness))
 7 recommendations          (LLM: 24h / 3-day / 7-day plans, next focus)
 8 build-report             (interviewReports rev 0)
 9 render-pdf               (pdf queue)
10 notify                   (email "report ready")
→ REPORT_READY
```

- A BullMQ **flow** with deterministic job IDs (`{sessionId}:{stage}:{version}`) means duplicates are no-ops. Each stage writes its status to `session.processing`. A failure retries with backoff, then marks the stage `FAILED` and alerts the admin. **The transcript is never lost.** Admin can re-run from a stage.
- Scoring restrictions (§33) are enforced in prompts **and** structurally: the scoring inputs contain no video, image or voice-prosody features. Communication is scored from transcript text only.
- Manual review creates `interviewScores`/`interviewReports` revision _n+1_ with the reviewer, reason and timestamp. Revision 0 is never modified.

---

## 9. Media, device check & proctoring

- **Device check** (client, lazy chunk): browser/feature detection (`getUserMedia`, `MediaRecorder`, `MediaRecorder.isTypeSupported` over the candidates `video/webm;codecs=vp9,opus` → `vp8,opus` → `video/mp4;codecs=avc1,mp4a` for Safari), mic level meter, camera preview, speaker test tone, network RTT/throughput probe against the API, and a server round-trip to STT/TTS health. Each result is pass/warn/fail with actionable copy. Results are persisted to the session.
- **Recording**: `MediaRecorder` with a 10 s timeslice, uploaded as numbered segments through the API streaming straight to Bunny. Segments are retried with backoff and survive reconnects (the client keeps a small IndexedDB queue of un-acked segments). A finalize job writes a manifest (and optionally remuxes to a single file with ffmpeg in the worker). A failed upload marks the media asset `PARTIAL`; it never fails the interview.
- **Playback**: a short-lived Bunny token-auth URL (5 min), issued only after an authorization check, with every admin playback audited.
- **Retention**: `retentionExpiresAt` is set from the campaign or system setting (default 90 d). A daily `media-cleanup` job deletes the Bunny objects and marks `deletion.status`.
- **Proctoring**: the policy comes from the template or campaign. Client emits §37 events, which are stored as observations only. The report shows counts and a timeline with neutral wording, and never labels the candidate a cheater.

---

## 10. Coding round

- The `JudgeAdapter` interface: `listLanguages()`, `submit({language, source, tests, limits}) → token`, `status(token)`, `result(token)`. Requests are signed with HMAC-SHA256 over `timestamp.method.path.bodyHash` using a shared secret, with a ±5 min clock window. Implementations: `CodeBegunJudgeAdapter` (target), `Judge0Adapter` (interim, separate host) and `MockJudgeAdapter` (dev/test only).
- Hidden tests are stored server-side and sent to the judge, never to the browser.
- Judge unavailable → the coding round shows "run temporarily unavailable" and the candidate can still submit code for AI review. The round is marked `judge_unavailable` so confidence is reduced accordingly. The interview never crashes.
- Monaco is lazy-loaded. Autosave every 5 s and on blur. On mobile, show a banner recommending a laptop without blocking.

---

## 11. Payments & credits flow

```text
POST /payments/orders {planCode, couponCode?}
  server: load plan (DB) → apply coupon (DB) → amount → Razorpay order → purchases(CREATED) + payments
client: Razorpay Checkout → POST /payments/verify {order_id, payment_id, signature}
  server: HMAC verify → markPaid(purchaseId)   ─┐
webhook payment.captured / order.paid          ─┤→ markPaid is idempotent:
  server: verify X-Razorpay-Signature on raw body│   txn { purchases CREATED→PAID (conditional update);
          insert webhookEvents (unique) ────────┘         creditLedger PURCHASE (idempotencyKey = purchase:<id>);
                                                         creditAccounts update }
payment.failed → FAILED; refund.processed → REFUNDED + ledger ADMIN_ADJUSTMENT/negative (policy-defined)
```

- The first of the frontend verify and the webhook to arrive issues the credits. The second is a no-op because of the conditional update and the unique ledger key.
- A reconciliation job (hourly) fetches Razorpay order status for purchases stuck in `CREATED` for more than 30 min.
- Seed plans: FREE (₹0, 1 credit, granted once per verified account via `FREE_GRANT` keyed by `userId`), SPRINT (₹199, 3 credits, 7 d), JOB_HUNT (₹499, 12 credits, 30 d). All values are editable in Admin.

---

## 12. Candidate UI screen map

The layout shell is a top nav (logo slot, language switcher, credits, avatar menu) with focus layouts (no nav) for the interview room and checkout. Routes are code-split.

| #     | Route                                                                    | Screen                                                    | Wireframe notes                                                                                                                                                                                                                            |
| ----- | ------------------------------------------------------------------------ | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1     | `/`                                                                      | Landing                                                   | Hero with the value proposition, a 3-step "how it works", a sample report preview, pricing teaser, FAQ, CTA. No login needed                                                                                                               |
| 2–3   | `/login`, `/login/verify`                                                | Login / OTP                                               | Google button, email or mobile tab, 6-digit OTP input with resend countdown and throttling message                                                                                                                                         |
| 4     | `/app`                                                                   | Dashboard                                                 | Start-interview CTA, credits card, recent interviews list, readiness trend sparkline per target role                                                                                                                                       |
| 5–9   | `/app/new` (wizard)                                                      | Start → Resume → JD (paste / upload / URL) → Company/Role | 4-step stepper. Each step is skippable where allowed. Clear extraction status and "we could not read this page" fallback                                                                                                                   |
| 10    | `/app/interviews/:id/analysis`                                           | Role analysis result                                      | Detected role, seniority, top skills with weights, planned rounds and duration, JD vs resume vs company-pattern badges. "Looks right / edit"                                                                                               |
| 11–12 | `…/setup`                                                                | Interview setup + language                                | Mode choice (as permitted), language / Auto, duration summary, credit cost                                                                                                                                                                 |
| 13    | `…/device-check`                                                         | Device check                                              | Checklist with pass/warn/fail rows, fixes inline                                                                                                                                                                                           |
| 14    | `…/consent`                                                              | Consent                                                   | What is recorded, why, who can see it, retention, optional vs required, checkbox + accept                                                                                                                                                  |
| 15    | `…/start`                                                                | Waiting / start                                           | Rules recap, "Start interview" (credit reservation happens here)                                                                                                                                                                           |
| 16–18 | `…/room`                                                                 | Text / Voice / Video room                                 | Interviewer panel (branded visual, speaking indicator), current question, captions, candidate self-view (video), answer area or mic control, progress by round, timer, connection pill, End (confirm), Report problem. **No scores shown** |
| 19    | `…/room` (coding round)                                                  | Coding                                                    | Split: problem + tests / Monaco + language, Run, Submit, console. Stacked on mobile with a desktop recommendation                                                                                                                          |
| 20    | overlay                                                                  | Reconnecting                                              | Non-blocking overlay, retry countdown, "your progress is saved"                                                                                                                                                                            |
| 21–22 | `…/complete`                                                             | Complete / processing                                     | Thank-you, pipeline stage progress, email-when-ready note, feedback prompt                                                                                                                                                                 |
| 23–24 | `/app/reports/:id`                                                       | Readiness report + plan                                   | See §12.1                                                                                                                                                                                                                                  |
| 25–26 | `/app/history`, `/app/compare`                                           | History / comparison                                      | Table (role, company, date, score, duration, language, status). Compare picks 2–4 attempts of the same role and shows dimension deltas                                                                                                     |
| 27–30 | `/pricing`, `/app/checkout/:plan`, `/app/payments/:id`, `/app/purchases` | Pricing / checkout / status / history                     | Plan cards, coupon field, server-computed total, success/pending/failed states                                                                                                                                                             |
| 31–32 | `/app/profile`, `/app/privacy`                                           | Profile / privacy                                         | Identities linked, language, consents, data export, delete account                                                                                                                                                                         |
| 33–34 | `/campaign/:token`                                                       | Campaign landing / join                                   | Company, role, what's assessed, recording requirements, report-sharing disclosure, join CTA → login → consent                                                                                                                              |
| 35    | modal and `/app/reports/:id#feedback`                                    | Feedback                                                  | Usefulness, accuracy, interview quality (1–5), free text, "will you retake?"                                                                                                                                                               |

### 12.1 Report screen layout

1. Header: role, company, date, mode, duration, language, AI-generated disclaimer.
2. **Overall readiness** gauge with a label ("Interview-ready with gaps"), plus a separate **Evidence confidence** chip (High/Medium/Low with an icon and text, never colour alone).
3. Dimension bars (horizontal, sorted), each expandable to show evidence snippets and the questions that produced them.
4. Strengths / Gaps two-column cards using hedged, evidence-referenced wording.
5. Round breakdown, coding result, resume/JD coverage matrix.
6. Plans: **Next 24 h / 3 days / 7 days** tabs.
7. Progress vs previous attempts (if any), retake CTA, PDF download.

A table view is always available as the accessible alternative to charts.

---

## 13. Admin screen map

Layout: left sidebar filtered by the admin's permissions, a top bar with environment badge (STAGING or PROD) and global search.

| Module                     | Screens                                                                                                                                                                                                                                                  |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dashboard                  | KPI tiles (registrations, active users, started/completed, completion %, free→paid %, revenue, AI cost, gross-margin estimate, active sessions, failed sessions), funnel chart, provider health strip, §57 target indicators                             |
| Candidates                 | Search list → detail tabs: profile, identities, interviews, purchases, credit ledger (with adjust action), reports, media, feedback                                                                                                                      |
| Interviews                 | Filterable list by state (active, processing, failed, flagged) → detail: timeline, transcript with the question ledger, evidence, scores (all revisions), recordings, integrity events, AI usage/cost, "re-run stage", "flag for review", "revise score" |
| Roles                      | Canonical library, blueprint versions (diff view), promote AI-generated → canonical, activate/deactivate                                                                                                                                                 |
| Companies                  | Profiles, verified pattern notes (with source and verifier), role overlays                                                                                                                                                                               |
| Templates                  | Template editor (rounds, durations, weights, proctoring, reporting), versions                                                                                                                                                                            |
| Campaigns                  | Create wizard, invite link and QR, candidate results grid (filters on dimension scores), open Candidate Proof, CSV export, report package export                                                                                                         |
| AI Providers               | Providers (masked keys, rotate), models and pricing (effective-dated), feature routing and fallback chains, latency/error charts, cost explorer                                                                                                          |
| Plans / Coupons / Payments | CRUD with versioning, orders and payments with status history, reconciliation view, refund initiation (FINANCE)                                                                                                                                          |
| Languages                  | UI / interview enablement, provider capability matrix                                                                                                                                                                                                    |
| Media                      | Recordings with retention and deletion state, manual purge                                                                                                                                                                                               |
| Feedback                   | Ratings distribution, report-accuracy trend, free text                                                                                                                                                                                                   |
| Audit                      | Searchable admin and security events                                                                                                                                                                                                                     |
| System                     | Feature flags, settings (retention, upload limits, thresholds), queue dashboard (BullMQ counts, failed jobs, retry), health, maintenance mode                                                                                                            |

---

## 14. Deployment architecture

- **Containers** (`docker-compose.production.yml`): `nginx`, `api-blue`, `api-green`, `worker` (×N), `mongo` (if self-hosted), `redis`, `certbot`. Static SPAs are built into the `nginx` image, or a volume is served by it.
- **Networks**: `edge` (nginx only publishes 80/443), `internal` (api, worker, mongo, redis). **Mongo and Redis publish no host ports.**
- **Zero-downtime deploy**: bring up the idle colour → `/readyz` passes → flip the NGINX upstream → the old colour receives SIGTERM → it stops accepting sockets, emits `server:draining`, and clients reconnect to the new colour, rehydrating from Mongo → the old colour exits after in-flight turns finish (max 60 s). Workers finish their current job (BullMQ graceful close).
- **Environments**: dev (Docker Compose), test (CI, ephemeral Mongo/Redis service containers), staging (`*-staging` subdomains, basic-auth or IP allowlist at NGINX, separate DB), production.
- **CI/CD (GitHub Actions)**: install (pnpm cache) → lint → typecheck → unit → integration (Mongo/Redis service containers) → frontend component tests → build → Playwright (mock providers) → Docker build and push (GHCR) → deploy staging over SSH → health check → manual approval → production blue/green. Rollback means redeploying the previous image tag (documented runbook).
- **Backups**: `mongodump --archive --gzip` nightly (7 daily, 4 weekly), encrypted with `age`, pushed to a separate Bunny Storage zone. A monthly automated **restore test** goes into a scratch container.
- **Hardening**: SSH keys only, `ufw` allowing 22/80/443, fail2ban, unattended-upgrades, Docker log rotation, disk alerts, non-root containers, read-only root filesystems where possible.
- **Sizing guidance** for 200 concurrent interviews: this is I/O-bound (AI is external). A Hostinger KVM 8 (8 vCPU / 32 GB) comfortably hosts API ×2, worker ×2, Redis and Mongo. Confirm with k6 in the hardening phase.

---

## 15. Branding & design system

Approved baseline: brand **CodeBegun**, product **CareerPilot Interview**, secondary branding **"by CodeBegun"**, Bootstrap 5, a clean, professional, minimal style with no excessive gradients or animation, and mobile-first layouts.

- **Tokens:** `--cb-primary` (#051D64, approved), `--cb-secondary` (#359AAD, approved), `--cb-background` (#FFFFFF, approved), plus `--cb-surface`, `--cb-surface-muted`, `--cb-text-primary`, `--cb-text-secondary`, `--cb-border`, `--cb-success`, `--cb-warning`, `--cb-danger` and `--cb-info`. The non-approved values are provisional neutral defaults.
  - Single source: `packages/design-system/src/styles/_tokens.scss`. It emits the CSS custom properties and feeds Bootstrap's Sass variables.
  - ESLint rejects raw hex literals in web code.
- **Logos:** every path lives in one registry (`packages/design-system/src/brand/brand-assets.ts`). Files are served from `apps/*/public/brand/`.
  - `<BrandLogo>` renders the official file and falls back to `BrandLogoPlaceholder`, a dashed "[logo pending]" marker, when the file is missing.
  - Adding the official files needs no code change.
  - No logo artwork has been or will be generated.
- **Release gate:** `pnpm brand:check` fails while assets are missing. The full list is in `docs/product/brand-assets-required.md`.

---

## 16. Implementation phases

Each phase ends with lint, unit tests, integration tests, build, a report, docs updates and conventional commits (per §1 of the brief).

| Phase                                        | Scope                                                                                                                                                                                                                                                     | Exit criteria                                           |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| **P0 Foundation**                            | Monorepo, tooling, typed config, Pino logging with redaction, request IDs, health/ready, Docker Compose dev stack (Mongo RS, Redis), design tokens, i18n shell (en/te/hi), React app shells, OpenAPI pipeline, CI workflow, `.env.example`, docs skeleton | `pnpm dev` runs everything. CI green                    |
| **P1 Auth & users**                          | Google OAuth, email OTP (SMTP/SES adapter), mobile OTP (MSG91 adapter + mock), rotation/reuse detection, logout-all, account linking, admin RBAC, seed super-admin CLI, audit middleware, rate-limit classes, candidate login/onboarding screens          | Auth integration suite green                            |
| **P2 AI core**                               | Interfaces, router/fallback/circuit breaker, mock + OpenAI + Anthropic + Gemini LLM adapters, encrypted secrets, usage metering and cost calc, prompt registry, Admin AI Providers UI                                                                     | Cost calc and routing unit-tested. Mock blocked in prod |
| **P3 Inputs & roles**                        | Bunny adapter, resume upload/parse/OCR hook, JD paste/upload/URL with SSRF guard, companies, role library, blueprint generation and versioning, templates, wizard screens 5–12, admin roles/companies/templates                                           | SSRF test suite. Parsing fixtures                       |
| **P4 Interview engine (text)**               | State machine, planner, question ledger, Socket.IO room, reconnect/resume, credit ledger core + FREE grant + reserve/consume/refund, text room UI                                                                                                         | Engine exhaustively unit-tested. Reconnect E2E          |
| **P5 Evaluation & reports**                  | Pipeline flow, evidence, scoring-core, confidence, recommendations, report UI, PDF, email, history/compare, feedback, **AI eval fixture suite**                                                                                                           | Deterministic aggregation tests. AI regression runner   |
| **P6 Payments**                              | Plans, coupons, Razorpay orders/verify/webhook, reconciliation, pricing/checkout screens, admin payments                                                                                                                                                  | Webhook idempotency and double-issue tests              |
| **P7 Voice**                                 | Device check, Deepgram STT and ElevenLabs/OpenAI TTS adapters, voice room, degrade-to-text                                                                                                                                                                | Mocked voice E2E. Manual browser matrix                 |
| **P8 Video, consent, proctoring, retention** | Consent texts, MediaRecorder segmentation, Bunny segment upload, signed playback, integrity events, retention cleanup                                                                                                                                     | Upload-failure resilience tests                         |
| **P9 Coding**                                | JudgeAdapter (HMAC), Judge0 interim + mock, problems bank, Monaco round, coding evidence merge                                                                                                                                                            | Judge-down tests                                        |
| **P10 Campaigns & review**                   | Campaign CRUD, invite links, join flow, sponsored credits, results grid, CSV/package export, manual review revisions                                                                                                                                      | Campaign authorization tests                            |
| **P11 Admin analytics & ops**                | Analytics ingestion and rollups, dashboard KPIs, cost/margin views, system health, queue view, feature flags, public-proof architecture (flag off)                                                                                                        |                                                         |
| **P12 Hardening & launch**                   | k6 (200 sessions, mock providers), Playwright matrix, security review, VPS provisioning scripts, NGINX/TLS, backups + restore drill, runbooks, staging → production                                                                                       | Load target met. Restore proven                         |

---

## 17. Decision log

Resolved on 2026-09-23 (design approved; Phase 0 started):

| #   | Question              | Decision                                                                                                                                                                                          |
| --- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D4  | Voice architecture    | **Approved: cascaded STT → engine → TTS.** Realtime speech-to-speech stays a pluggable option for later                                                                                           |
| D3  | MongoDB in production | **Self-hosted** single-node replica set on the VPS, with authentication, keyfile, no public port, and encrypted off-box backups (Phase 12)                                                        |
| D9  | Code judge            | **No CodeBegun Judge API exists yet.** Build `JudgeAdapter` with an interim self-hosted Judge0-compatible judge on a **separate** host. Switch to CodeBegun Judge by configuration when it exists |
| —   | AI / speech providers | **All accounts available**: OpenAI, Anthropic, Gemini, Deepgram, ElevenLabs                                                                                                                       |
| —   | Email                 | **AWS SES**                                                                                                                                                                                       |
| —   | Branding              | Official logos and style guide **not yet available**. Proceed on the approved baseline (§15). This is a **release blocker** for production UI sign-off                                            |
| D1  | pnpm + Turborepo      | Adopted in Phase 0 (pnpm 10.34, Turborepo 2.11)                                                                                                                                                   |
| D2  | Toolchain pins        | Node 24 LTS. **TypeScript 6.0.3**, because typescript-eslint 8.x does not support TypeScript 7 yet. jsdom 29 (jsdom 30 needs Node ≥ 24.15)                                                        |

Still open:

1. **Remainder of the brief** (§89 onward) was truncated and has not been received.

---

## 18. Risks, assumptions, dependencies

| Risk / dependency                                                                    | Impact                       | Mitigation                                                                                                                                         |
| ------------------------------------------------------------------------------------ | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scoring validity of LLM evaluation                                                   | Core value (Goal A)          | Evidence-first pipeline, AI eval fixture suite, manual review revisions, feedback accuracy metric                                                  |
| India SMS needs **DLT registration** (entity + templates) before MSG91 can send OTPs | Mobile OTP blocked at launch | Start DLT registration now. Launch with email + Google if delayed                                                                                  |
| Google OAuth consent-screen verification                                             | Login friction               | Apply early, request minimal scopes (openid, email, profile)                                                                                       |
| Razorpay KYC / live keys                                                             | Payments blocked             | Test mode until approved                                                                                                                           |
| Safari MediaRecorder / codec differences                                             | Recording gaps on iOS        | Capability detection, mp4 fallback, recording optional in practice mode                                                                            |
| Voice latency and cost at scale                                                      | UX and margin                | Cascade with streaming, per-interview cost metering, admin model routing                                                                           |
| Single VPS is a single point of failure                                              | Downtime                     | Stateless services, backups, documented rebuild. Move DB off-box when revenue allows                                                               |
| No CodeBegun Judge yet                                                               | Coding round                 | Interim Judge0 on a separate host behind the adapter                                                                                               |
| Bunny Storage lacks presigned uploads                                                | API bandwidth on uploads     | Streamed proxy with 10 s segments. Revisit Bunny Stream TUS uploads if bandwidth hurts                                                             |
| Uploaded files may be malicious (zip bombs, crafted PDFs)                            | Worker DoS                   | Parse in the worker with limits and timeouts. Optional ClamAV                                                                                      |
| **DPDP Act 2023 (India)** obligations for personal data and consent                  | Legal                        | Configurable consent/privacy texts, deletion workflow, retention. **Legal review required before launch**. The UI makes no unreviewed legal claims |
| Prompt injection via resume/JD/speech                                                | Score manipulation           | Data delimiting, structured outputs, schema validation, evidence-based scoring, injection fixtures in the eval suite                               |

**Assumptions:** adult users only. INR only at launch. English/Telugu/Hindi UI at launch. Staging and production each get their own VPS or at least separate databases. The GitHub repo `mynameiscod/interview-pilot` is the canonical home.

---

## 19. Environment variables / secrets

| Variable                                                                                                                                                        | Purpose                                           | Secret  |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- | ------- |
| `NODE_ENV`, `APP_ENV` (`development`/`test`/`staging`/`production`)                                                                                             | Environment                                       |         |
| `PORT_API`, `PUBLIC_API_URL`, `PUBLIC_CANDIDATE_URL`, `PUBLIC_ADMIN_URL`                                                                                        | URLs                                              |         |
| `CORS_ALLOWED_ORIGINS`                                                                                                                                          | CORS allowlist                                    |         |
| `MONGODB_URI`                                                                                                                                                   | Mongo (replica set URI)                           | ✔       |
| `REDIS_URL`                                                                                                                                                     | Redis                                             | ✔       |
| `JWT_ACCESS_SECRET` (or `JWT_PRIVATE_KEY`/`JWT_PUBLIC_KEY` for EdDSA), `JWT_ACCESS_TTL` (default 10m), `REFRESH_TTL_CANDIDATE` (30d), `REFRESH_TTL_ADMIN` (12h) | Tokens                                            | ✔       |
| `COOKIE_DOMAIN`                                                                                                                                                 | Refresh cookie domain                             |         |
| `OTP_HMAC_SECRET`, `OTP_TTL_SEC`, `OTP_MAX_ATTEMPTS`                                                                                                            | OTP                                               | ✔       |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`                                                                                                                      | Google OAuth                                      | ✔       |
| `EMAIL_PROVIDER` (`ses`/`smtp`/`mock`), `SES_REGION`, `SES_ACCESS_KEY_ID`, `SES_SECRET_ACCESS_KEY` **or** `SMTP_HOST/PORT/USER/PASS`, `EMAIL_FROM`              | Email                                             | ✔       |
| `SMS_PROVIDER` (`msg91`/`mock`), `MSG91_AUTH_KEY`, `MSG91_OTP_TEMPLATE_ID`, `MSG91_SENDER_ID`                                                                   | SMS                                               | ✔       |
| `AI_SECRETS_MASTER_KEY` (base64 32 bytes), `AI_SECRETS_KEY_ID`                                                                                                  | Encrypts provider keys stored via Admin           | ✔       |
| `AI_MOCK_MODE`                                                                                                                                                  | Dev/test mock providers (refused in staging/prod) |         |
| `AI_BOOTSTRAP_*` (optional initial provider keys, imported once, encrypted)                                                                                     | First-run convenience                             | ✔       |
| `BUNNY_STORAGE_ZONE`, `BUNNY_STORAGE_REGION_HOST`, `BUNNY_STORAGE_ACCESS_KEY`                                                                                   | Private storage                                   | ✔       |
| `BUNNY_PULLZONE_HOST`, `BUNNY_PULLZONE_TOKEN_KEY`                                                                                                               | Signed playback                                   | ✔       |
| `BUNNY_BACKUP_ZONE`, `BUNNY_BACKUP_ACCESS_KEY`, `BACKUP_AGE_PUBLIC_KEY`                                                                                         | Backups                                           | ✔       |
| `RAZORPAY_KEY_ID` (public), `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`                                                                                    | Payments                                          | ✔       |
| `JUDGE_PROVIDER` (`codebegun`/`judge0`/`mock`), `JUDGE_BASE_URL`, `JUDGE_HMAC_SECRET`                                                                           | Code execution                                    | ✔       |
| `UPLOAD_MAX_MB` (default 8), `MEDIA_RETENTION_DAYS_DEFAULT` (90)                                                                                                | Defaults (admin-overridable)                      |         |
| `FEATURE_PUBLIC_PROOF_SHARING=false`                                                                                                                            | Flag default                                      |         |
| `LOG_LEVEL`, `SENTRY_DSN` (optional, future)                                                                                                                    | Observability                                     | ✔ (DSN) |
| `SEED_SUPER_ADMIN_EMAIL`                                                                                                                                        | One-time bootstrap                                |         |
| `STAGING_BASIC_AUTH` (NGINX)                                                                                                                                    | Staging protection                                | ✔       |
| Frontend (`VITE_API_URL`, `VITE_SOCKET_URL`, `VITE_RAZORPAY_KEY_ID`, `VITE_GOOGLE_CLIENT_ID`, `VITE_APP_ENV`)                                                   | Public build-time config, **no secrets**          |         |

GitHub Actions secrets: `SSH_HOST`, `SSH_USER`, `SSH_PRIVATE_KEY` per environment, plus `GHCR_TOKEN`. Runtime secrets live in a root-owned `.env.production` (mode 600) on the VPS, never in the repo or in images.
