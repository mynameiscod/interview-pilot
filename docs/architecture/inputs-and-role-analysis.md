# Inputs, role analysis and the interview library

Phase 3 covers everything that happens before an interview starts: the candidate's resume and job target, the role analysis that turns them into an assessment plan, and the admin-managed library (roles, blueprints, companies, templates) that the analysis draws on.

## The candidate flow

```text
Wizard (candidate-web /app/new)
  Resume ──POST /resumes──▶ storage + resumes{PENDING} ──documents queue──▶ extract + structure ──▶ READY | FAILED
  JD     ──POST /jobs──────▶ jobTargets{PENDING} ───────documents queue──▶ fetch/extract + structure ──▶ READY | FAILED
         (ROLE_ONLY targets are READY at once; PATCH /jobs/:id sets company and role later)
  ──POST /interviews──▶ session DRAFT (pins the ACTIVE template version)
  ──POST /interviews/:id/analyze──▶ ROLE_ANALYSIS ──analysis queue──▶ READY (analysis + blueprint) | FAILED (code)
Analysis screen polls GET /interviews/:id ──▶ Setup: PATCH /interviews/:id/setup {mode, language}
```

The API never parses files or fetches URLs. It checks, stores and enqueues. Untrusted work runs in the worker, where it has resource limits.

## Resumes and job descriptions

| Step          | Where  | What happens                                                                                                                                                                                                                                                                         |
| ------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Upload        | API    | One file, at most `UPLOAD_MAX_MB` (default 8). The type is detected from the **bytes** (PDF, DOCX, UTF-8 text). The file name and the browser's content type are ignored. Anything else gets `415`. The file name is only kept for display (path and control characters are removed) |
| Deduplication | API    | Uploading the same resume again (same SHA-256) returns the existing one. A candidate can keep up to 20 resumes                                                                                                                                                                       |
| Storage       | API    | Objects go to private storage under server-generated keys (`resumes/<userId>/<id>.pdf`). Bunny Storage in deployed environments, a local folder in development                                                                                                                       |
| Extraction    | worker | `@cbi/documents`: PDF text via unpdf (max 30 pages), DOCX via mammoth after a zip-bomb check (max 25 MB uncompressed), text as UTF-8. 30 s timeout. The text is cleaned and capped at 200,000 characters                                                                             |
| Scanned PDFs  | worker | A PDF with almost no text layer gets the `OCR_NEEDED` warning. An OCR hook is wired in but no OCR provider is configured yet, so an image-only PDF fails with `NO_TEXT`                                                                                                              |
| JD URL        | worker | Fetched through the SSRF guard (see [uploads and URL fetching](../security/uploads-and-url-fetching.md)). HTML is reduced to its readable content with Readability                                                                                                                   |
| Structuring   | worker | `resume.structure` / `jd.structure` prompts produce `ResumeStructured` / `JdStructured`. Contact details are excluded by design. If AI is unavailable the input is still `READY` with the raw text and the `STRUCTURE_UNAVAILABLE` warning                                           |
| Failure codes | both   | `UNSUPPORTED_TYPE`, `TOO_LARGE`, `CORRUPT`, `ENCRYPTED`, `NO_TEXT`, `TOO_MANY_PAGES`, `URL_BLOCKED`, `FETCH_FAILED`, `NOT_READABLE`, `INTERNAL`. The UI shows a specific next step for each                                                                                          |

Permanent problems (a corrupt file, a blocked URL, a 404) fail immediately. Transient ones (network errors, 5xx, timeouts) are retried three times with exponential backoff, then fail as `FETCH_FAILED` or `INTERNAL`. Jobs carry ids only and are idempotent, so a redelivered job does nothing once its input has finished.

## Role analysis

The analysis job moves a session from `ROLE_ANALYSIS` to `READY` or `FAILED`:

1. **Wait for inputs.** If the resume or JD is still extracting, the job reschedules itself every 2 s without using up a retry. After 3 minutes in `ROLE_ANALYSIS` it fails with `INPUT_TIMEOUT`. A failed input fails the session with `INPUT_FAILED`.
2. **`role.analyze`.** It sends the library role list, the typed role title, the JD, the resume and **verified** company notes. It gets back the role title, family, seniority, confidence, weighted skills with their sources (`ROLE`, `JD`, `RESUME`, `COMPANY`), resume highlights and gaps. Without a resume, the result cannot claim resume evidence: `inResume` is forced to false.
3. **Match a library role.** Priority: the role the candidate picked, then the model's `matchedRoleSlug`, then an exact title/alias match that ignores seniority words.
4. **Choose the blueprint.**
   - A bare library role (no JD, no resume) uses the role's **canonical** active blueprint.
   - With a JD or resume, `blueprint.generate` produces a **tailored** blueprint. The model's draft is normalised: keys become unique slugs and weights are rescaled to total exactly 100. It is then validated as `BlueprintContent` and stored as an `AI_GENERATED` blueprint that is private to the candidate.
   - If generation fails, the canonical blueprint is used. If there is none, the session fails with `AI_UNAVAILABLE`.
   - If `role.analyze` itself is unavailable but the candidate picked a library role, the analysis is derived from that role's canonical blueprint.
5. **Plan rounds.** For each template round, the plan lists up to three focus competencies (highest weight first) whose `roundTypes` include that round.
6. **Commit.** The `READY` transition is conditional on the `stateVersion` read at the start, so a cancel or a second job running at the same time cannot be overwritten. The session records `blueprintId`, the analysis and the prompt versions used (`promptVersions`).

Candidates can retry a failed analysis up to 5 times per session. Each retry is a new job (its id includes the state version).

### Session states in Phase 3

| From                       | To              | Trigger                                       |
| -------------------------- | --------------- | --------------------------------------------- |
| `DRAFT`, `FAILED`, `READY` | `ROLE_ANALYSIS` | `POST /interviews/:id/analyze`                |
| `ROLE_ANALYSIS`            | `READY`         | analysis job succeeded                        |
| `ROLE_ANALYSIS`            | `FAILED`        | analysis job failed (`failure.code` says why) |
| `DRAFT`, `READY`, `FAILED` | `CANCELLED`     | `POST /interviews/:id/cancel`                 |

Transitions go through `transitionSession()` in `@cbi/db`: an atomic `findOneAndUpdate` on `{_id, state, stateVersion}` that increments `stateVersion` and appends to `stateHistory` (last 50). The Phase 4 engine replaces the table with the full state machine and keeps the same persistence rules. `mode` and `language` can be changed only in `READY`. Only modes the platform can run today (`AVAILABLE_INTERVIEW_MODES`, currently text) and that the template allows are accepted.

## The interview library

| Collection           | Versioned            | Notes                                                                                                                                                                                      |
| -------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `roles`              | no                   | Canonical title, slug, family, default seniority, aliases, `activeBlueprintId`. Seeded: Backend Engineer, Frontend Engineer, Data Analyst, QA Engineer                                     |
| `roleBlueprints`     | append-only          | `CANONICAL` versions per role (one `ACTIVE`, enforced by a partial unique index) and private `AI_GENERATED` blueprints. Content can never be updated or deleted; only status fields change |
| `companies`          | no                   | Name, slug, description, role families, allowed question categories, **verified patterns** (note, source type, source URL, verifier, verified at)                                          |
| `interviewTemplates` | append-only by `key` | Rounds (type, duration, question count, difficulty, follow-up depth, minimum evidence), modes, credit cost, proctoring, scoring weights (total 100), report policy                         |

- A session pins the exact template version (`templateId`) when it is created, and the exact blueprint (`blueprintId`) when it is analysed. Admin edits never change an existing session.
- Only verified company notes reach prompts. Candidates only see company names (`GET /companies`), never notes.
- Admins can **promote** a good AI-generated blueprint into a role. This copies it as the role's next `DRAFT` version, which must then be activated. Promotion records only ids, never the candidate's inputs.
- The seed (`ensureLibraryCatalog`, run at API start) only fills gaps. It never changes what admins have edited.

### Admin permissions

| Section                                 | Read           | Change           |
| --------------------------------------- | -------------- | ---------------- |
| Roles, blueprints, companies, templates | `library.read` | `library.manage` |

Both belong to super, operations and content admins. Every change is audited in the same transaction, with a reason for version activation and promotion.

## Prompts

Four analysis prompts are seeded as version 1 (`packages/db/src/seed/prompts-content.ts`): `resume.structure`, `jd.structure`, `role.analyze` and `blueprint.generate`. All candidate text is passed with `untrusted()`, so it lands in delimited `<data>` blocks with the data-only instruction. Every prompt forbids invented facts, contact details and inferences about protected characteristics. Edit them in **Admin → Prompts**: a new version, then activate. The live interview's prompts (`interview.question`, `interview.assessTurn`) are described in [the live interview](live-interview.md).

## Limits and quotas

| Limit                            | Value                               |
| -------------------------------- | ----------------------------------- |
| Upload size                      | `UPLOAD_MAX_MB` (8)                 |
| Uploads (resumes and JD files)   | 20 per 10 minutes per user          |
| JD URL submissions               | 10 per 10 minutes per user          |
| Analysis requests                | 15 per 10 minutes per user          |
| Stored resumes                   | 20 per user                         |
| Unfinished interviews            | 10 per user                         |
| Analysis attempts per interview  | 5                                   |
| Text sent to structuring prompts | 24,000 characters                   |
| Text sent to analysis prompts    | 12,000 characters each (JD, resume) |
