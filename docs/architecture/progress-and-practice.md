# Progress hub, practice drills and the habit loop

The candidate dashboard is the progress hub: how ready the candidate is and how that changes, what to practise next, and a light habit loop (streaks, a weekly goal, a target date, milestones). Practice drills are short sessions on one skill that feed the same trends. Readiness certificates let a candidate prove a good result.

## Parts

| Part                  | Where                                                                                                                                      |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Contracts             | `packages/shared-types/src/progress.ts` (and `practice` in `system.ts`, `kind`/`drill` on `InterviewSummary`)                              |
| Rules (pure)          | `packages/scoring-core/src/progress.ts`: India-time days, streaks, weekly goal, schedule, trends, badges, band threshold                   |
| Drill planning (pure) | `packages/interview-engine/src/drill.ts`: round type, one-competency blueprint, drill planner                                              |
| Data                  | `packages/db/src/models/progress.ts` (`planItemProgress`, `userProgress`, `badgeAwards`, `certificates`), `packages/db/src/progress.ts`    |
| API                   | `apps/api/src/modules/progress/` (hub, drills, unsubscribe routes), `modules/ops/certificates.service.ts`                                  |
| Worker                | drill evaluation in `evaluation/pipeline.ts`, `evaluation/certificate-pdf.ts`, `processors/certificate.ts`, `processors/practice-nudge.ts` |
| Candidate app         | `apps/candidate-web/src/features/progress/` and `features/dashboard/DashboardPage.tsx`                                                     |

## The hub: `GET /users/me/progress`

One call returns everything the dashboard shows (`ProgressOverview`). It reads the latest candidate-visible revision of each report (without transcripts or evidence) and the finished sessions.

- **Readiness trend**: the overall score of every completed interview, oldest first (drills are not interviews and are left out). The headline is the latest point; the change is against the previous scored attempt at the same role (`roleKey`).
- **Dimension trends**: for the role of the latest interview, every interview and drill at that role, per dimension. Attempts can use different blueprint versions, so dimensions are matched by key and, when an AI-generated blueprint renamed a key, by name. The latest blueprint's dimensions come first (even before they have a score); a dimension the latest blueprint dropped stays while it has scores (`current: false`). An unscored ("not assessed") dimension adds no point, never a zero.
- **Current plan**: the latest interview report's 24-hour / 3-day / 7-day plan as a checklist. Items are identified per report revision (`next24h.0`), so a reviewed revision starts a fresh checklist. `PUT /users/me/progress/plan-items` ticks an item done or undone; each item naming a dimension of the report has a "Practise this" action that opens a drill on it.
- **Streak**: consecutive India-time days with a finished interview or drill (state `PROCESSING` or `REPORT_READY`; cancelled, failed and expired sessions do not count). The current streak survives until a whole day passes without practice. Streaks look back 400 days.
- **Goals**: sessions per week (Monday–Sunday, India time; default the `practice.defaultWeeklyGoal` setting) and an optional target interview date, set with `PUT /users/me/progress/goals` (today to a year ahead). With a date, the hub shows a countdown and a suggested schedule: sessions spaced to meet the weekly goal, drills on the three weakest dimensions in turn, a full interview every third session and a full mock interview the day before.
- **Badges**: first interview, first voice (or video) interview, 3-day and 7-day streaks, +10 readiness over the first attempt at a role, every item of a plan done, and a coding problem with every test passed. The hub computes them from the facts and records new ones in `badgeAwards` (unique per user and badge, `$setOnInsert`), so awarding is idempotent, concurrent reads cannot award twice, and a badge is never taken back. `awardedAt` is when the facts earned it.
- **Drills**: today's quota and the five latest drills with their scores.

## Practice drills

A drill is an interview session with `kind: 'DRILL'` and `drill: {competencyKey, competencyName, sourceSessionId}`. It reuses everything the live interview has: the state machine, the planner, the room (text or voice), reconnects, the sweep and the evaluation pipeline.

1. **Create** (`POST /drills {dimensionKey, sourceSessionId?, mode}`): the source is the named interview or, by default, the candidate's latest completed interview with a blueprint. The dimension must be a competency of that blueprint. The drill copies the source's job target, resume, blueprint version and analysis (with a one-round plan), uses the active version of the seeded, versioned **`skill-drill` template**, and starts in `READY`. Creating a drill for the same skill, mode and source again returns the unstarted one; any other unstarted drill is cancelled (one at a time).
2. **Start** (`POST /interviews/:id/start`, as for interviews): text drills start straight from the drill screen; voice drills go through the device check and voice consent first. The planner is `createDrillPlanner`: one round of the template round's rules with `practice.drillQuestions` questions (default 3), its budget scaled per question (about 2 min 20 s each, so 7 minutes for three), on the chosen competency only, with no resume/JD probe areas. The round type follows the competency (never intro, wrap-up or coding). The question prompts see a blueprint with that one competency.
3. **Quick evaluation**: the pipeline runs with the drill's one-competency blueprint, so evidence, the score and the overall (equal to that dimension's score) cover that skill only. Recommendations are the deterministic ones (no AI call), and there is no PDF and no email. The report revision is stored with `kind: 'DRILL'`: it feeds dimension trends but not report history, comparisons, "since your last attempt", analytics KPIs or the readiness trend.
4. **Result** (`GET /drills/:id`): the score, the dimension's previous score (latest earlier interview or drill), confidence, rationale and the feedback per question (the evidence claims for each answer, once evaluated).

`GET /interviews` lists interviews only; drills are listed by the hub.

### Pricing

Drills are **free up to `practice.drillsPerDay` per India-time day (default 3)** and then refused with `402 DRILL_LIMIT_REACHED` until the next day; the candidate is offered a full interview (which uses a credit) instead. A drill never touches the credit ledger: starting it records the credit status `FREE`, and the engine settles only reserved credits, so the reserve / consume / refund invariants and their tests are unchanged.

This is the simplest rule that stays consistent with the integer ledger: fractional credits would need a new ledger unit, and "1 credit per 3 drills" would need a new kind of reservation that spans sessions. The quota counts drills **started** that day (a drill ended early still counts). The check runs before the start; one live session per candidate (a unique index) keeps two starts from racing past it. `drillsPerDay: 0` switches drills off.

## Readiness certificates

Certificates ride on Candidate Proof: the same `reports.publicProof` flag (off by default), and while it is off every certificate endpoint answers 404.

- `GET /reports/:sessionId/certificate` says whether the latest visible interview report reaches `practice.certificateMinBand` (default "ready with gaps"; `INSUFFICIENT_EVIDENCE` never qualifies) and returns the certificate if issued.
- `POST /reports/:sessionId/certificate` issues it once per interview (unique `{userId, sessionId}`; a second call returns the first) and queues `evaluation.certificate_pdf`. The facts are frozen at issue: the display name, role, score, band and dates. The code (`CPI-XXXX-XXXX-XXXX`, 60 random bits from an unambiguous alphabet) is printed on the certificate.
- The worker renders a one-page landscape A4 PDF with pdfkit and the report's embedded Noto/Hind Guntur fonts (so Hindi and Telugu names print), falling back to the standard fonts like reports. It carries the verification URL `<PUBLIC_CANDIDATE_URL>/verify/<code>` as a link. `GET /reports/:sessionId/certificate/pdf` downloads it (409 while it is being prepared).
- `GET /certificates/:code` is the public check (`noindex`): the frozen facts, and `superseded` when a later manual review changed the report. A report hidden later (for example by a campaign) stops being verifiable. A proof link of the same interview also shows the certificate's check link.
- Certificates and their PDFs are erased with the account.

## Practice nudges (email)

The worker's `practice-nudge` job (every `WORKER_PRACTICE_NUDGE_INTERVAL_MS`, default 6 hours) emails candidates who **opted into product updates** (`productUpdatesOptIn`), have a verified email and an active account, and have practised before:

- **streak at risk**: a streak of two or more days that ends yesterday, and no practice today;
- **come back**: three or more days without practice.

At most one nudge per candidate every 3 days: before sending, the job claims the slot with one conditional write on `userProgress` (unique per user), so replicas and retries never double-send; a failed send is not retried sooner. Nothing is sent while email is not configured. Messages are in the candidate's preferred interview language (English, Hindi or Telugu; English for "auto"). In-app, the hub shows the same information; there are no push notifications.

Every nudge ends with a one-click unsubscribe link, `<PUBLIC_CANDIDATE_URL>/unsubscribe?token=…`. The token (user, purpose, issue time) is signed with HMAC-SHA256 under a key derived from `AI_SECRETS_MASTER_KEY` with a fixed label (`@cbi/auth-core` `email-links`), which the API and the worker share; tokens older than 400 days are refused, and rotating the master key invalidates older links (the profile setting still works). The page asks for a click and posts the token to `POST /email/unsubscribe` (no sign-in; allowed during maintenance), which turns `productUpdatesOptIn` off and audits `profile.product_updates_unsubscribed`. Link scanners that only fetch the page unsubscribe nobody.

## The dashboard

- A greeting with the readiness headline (score, band, change), **Start interview** and **Quick drill** (the weakest current skill; disabled with an explanation until the first interview).
- **Readiness over time**: a Chart.js line chart through `react-chartjs-2`, lazy-loaded so Chart.js is a separate chunk. Colours are read from the design tokens (`--cb-primary`, `--cb-secondary-strong`, `--cb-border`, `--cb-text-secondary`) at render time. The canvas has a text summary, and the same data is in a visually hidden table.
- **Skills**: each dimension with its latest score, change and a small SVG sparkline (stroke and fill from CSS tokens), a Practise link, and the scores in a visually hidden table.
- **Your plan**: the checklist (updates at once and rolls back if the save fails), progress bar and Practise actions.
- **Streak and goals**, **Milestones**, **Recent interviews**, **Recent drills**, **Credits**, and the practice-area tiles, which now link to a drill on the weakest skill in that area (technical/domain, problem solving, behavioural/communication) or to a new interview (coding, or no skills yet).
- New candidates see a designed empty state (three steps and the start button) with the streak and credits cards.

All strings are in English, Hindi and Telugu.

## Configuration

| Setting                                | Default           | Meaning                                                                      |
| -------------------------------------- | ----------------- | ---------------------------------------------------------------------------- |
| `practice.drillsPerDay` (system)       | 3                 | Free drills per candidate per India-time day; 0 turns drills off             |
| `practice.drillQuestions` (system)     | 3                 | Questions per drill (1–6)                                                    |
| `practice.certificateMinBand` (system) | `READY_WITH_GAPS` | Lowest band that can be certified (`READY`, `READY_WITH_GAPS`, `DEVELOPING`) |
| `practice.defaultWeeklyGoal` (system)  | 3                 | Weekly goal until the candidate sets one                                     |
| `reports.publicProof` (flag)           | off               | Candidate Proof links and readiness certificates                             |
| `WORKER_PRACTICE_NUDGE_INTERVAL_MS`    | 6 hours           | How often nudges are considered (at least 10 minutes)                        |
| `skill-drill` template (library)       | 1 round, 7 min    | The drill round's rules; a new version is created like any template          |

The `practice` settings are edited in Admin → System → Settings → Practice and certificates.
