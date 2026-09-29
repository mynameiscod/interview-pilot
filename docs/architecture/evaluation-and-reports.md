# Evaluation and readiness reports

Phase 5 turns a finished interview into an evidence-backed readiness report: evidence first, deterministic scoring, AI-written recommendations, a PDF and an email. This page describes the pipeline, the scoring rules and the report. The AI regression suite is described in [AI evaluation regression](../ai/evaluation-regression.md).

## When it runs

An interview reaches `PROCESSING` when it finishes, when the candidate ends it early, or when a meaningful paused interview expires ([live interview](live-interview.md)). The engine then emits `ENQUEUE_EVALUATION`. The API calls `beginEvaluation`, which starts run 1 exactly once, and enqueues the first stage on the `evaluation` queue. If that enqueue is lost, the worker's sweep starts any `PROCESSING` session that has no evaluation run after 30 seconds.

## The pipeline

One BullMQ job per stage, id `evaluation-<session>-<stage>-<run>`, so a duplicate is a no-op. Each finished stage enqueues the next one. Progress is recorded on the session (`processing: {run, stage, status, completed[], attempts, error}`), which the completion screen polls.

| #   | Stage                 | Does                                                                                                                                                                                                                                                      | If the AI is unavailable                                             |
| --- | --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| 1   | `FINALIZE_TRANSCRIPT` | Checks the transcript is complete (turns are already final once the session is `PROCESSING`)                                                                                                                                                              | —                                                                    |
| 2   | `EXTRACT_EVIDENCE`    | Per round, `evaluation.extractEvidence` turns answers into evidence items: claim, strength −2…+2, confidence, practical, quote. Items naming unknown questions or competencies are dropped; quotes not found in the cited answer are removed (see below)  | The live turn assessments become evidence (STRONG +2 … NO_ANSWER −2) |
| 3   | `SCORE_DIMENSIONS`    | Per competency with evidence, `evaluation.scoreDimension` scores 0–100 **from that competency's evidence and rubric only**. Up to three competencies are scored at once (`SCORING_CONCURRENCY`)                                                           | The score comes from the evidence strengths alone (`fallback`)       |
| 4   | `AGGREGATE`           | Deterministic, in `@cbi/scoring-core`: evidence guard, weighted overall, confidence, band. Writes `interviewScores` revision 0                                                                                                                            | —                                                                    |
| 5   | `RECOMMENDATIONS`     | `report.recommendations`: summary, strengths, gaps and the 24-hour / 3-day / 7-day plan, written in the interview language (below)                                                                                                                        | Score-based recommendations (English)                                |
| 6   | `COACHING`            | `report.questionFeedback` per answered question (up to three at once, `COACHING_CONCURRENCY`): verdict, what worked, what was missing, an example answer and STAR for behavioural questions, in the interview language, cached on the turn (see Coaching) | The live assessment, the expected evidence and the STAR heuristic    |
| 7   | `BUILD_REPORT`        | Writes `interviewReports` revision 0 (with the coaching sections and the peer benchmark) and moves the session to `REPORT_READY`                                                                                                                          | —                                                                    |
| 8   | `RENDER_PDF`          | Renders the PDF (pdfkit) to private storage                                                                                                                                                                                                               | —                                                                    |
| 9   | `NOTIFY`              | Emails "Your report is ready" with a link (or "submitted" for campaigns that hide the report), in the interview language, when worker email is configured and the address is verified                                                                     | —                                                                    |

- **Drills are evaluated quickly.** For a practice drill (`kind: 'DRILL'`) every stage sees a blueprint with the drill's one competency, so the overall score is that dimension's score; recommendations are the deterministic ones (no AI call); `RENDER_PDF` and `NOTIFY` do nothing. The report is stored with `kind: 'DRILL'` and feeds the progress hub's dimension trends, but not history, comparisons or "since your last attempt" ([progress and practice](progress-and-practice.md)).
- **A report is always produced.** Every AI step has a deterministic fallback, so a provider outage slows a report down (retries and timeouts) but never stops it.
- **Failures keep everything.** A stage that still fails after 3 attempts is marked `FAILED`; the transcript, evidence and earlier results stay, and the session stays in `PROCESSING`. An operations admin re-runs it with `POST /admin/interviews/:id/reprocess` (a new run, audited). The sweep re-queues stages that stall for 10 minutes.
- **Stage outputs are idempotent.** Evidence is replaced per run and round, and score and report revision 0 are written once (unique index).
- **The report is visible before the PDF.** `REPORT_READY` happens at stage 7; the PDF and email follow.

### Evidence quotes are verified

A quote is shown in a report as the candidate's own words, so it must be in their answer. After extraction, each quote is looked up in the answer to the question it cites (`evaluation/quotes.ts`): case, punctuation and whitespace are normalised (any script), quotes of four or more words may miss up to 15 % of their words in order (transcription slips, filler words), and elided quotes (`a … b`) must match each fragment in order. A quote that cannot be found is removed, that item's confidence is multiplied by 0.6 and its `uncertainty` says why; the claim itself stays. Each removal is logged with `metric: "evaluation.quote_unverified"` (counts, prompt version and model, never the text). Building the report checks quotes against the transcript again, which also covers evidence stored before this check. The `quote-grounding` regression fixture tracks how often a model invents quotes.

### Output language

Recommendations and the result emails use the session's interview language (`en`, `hi`, `te`). For `auto`, the answers decide: Hindi when at least 30 % of their letters are Devanagari, Telugu likewise, otherwise English (Hindi or Telugu typed in Latin letters stays English). The score-based fallback recommendations and the report's fixed headings are English for now; the PDF renders any mix of scripts (see PDF fonts).

## Coaching

The report also coaches: per-question feedback, STAR structure, delivery and a peer benchmark. **None of it changes a score.** Competency scores, weights, the overall score and confidence come only from the evidence and `@cbi/scoring-core` as described below; coaching is computed alongside and stored with the report revision.

### Per-question feedback (`COACHING` stage)

Every question answered in words gets a card (coding questions have their own section): the question, the answer (collapsed; hidden when the template's report policy hides the transcript), a verdict (strong, adequate, weak or not assessed), what worked, what was missing and an **example answer**.

- `report.questionFeedback` (prompt seeded in `packages/db/src/seed/prompts-content.ts`, routed like every LLM feature) sees the role, round, competency and its expected evidence, the question, the answer and the evidence already extracted for it. The answer and the evidence are passed with `untrusted()`; spoken answers carry the "spoken, automatically transcribed" label. The prompt judges content, never accent, fluency or grammar.
- **The example answer is rewritten from the candidate's own content.** The prompt forbids adding employers, projects, tools, numbers or outcomes and asks for placeholders (`[your metric]`, `[name]`, localised for Hindi and Telugu) where a fact is missing. `evaluation/improved-answer.ts` then checks it against the answer and the question: a number the candidate never gave becomes the metric placeholder, and a capitalised name mid-sentence that the candidate never used withholds the example entirely (it cannot be repaired without guessing). Each finding is logged with `metric: "evaluation.improved_answer_ungrounded"` (counts only, never text). The card labels the example as built from the candidate's answer and tells them to say only what they have done.
- Results are cached on the turn (`interviewTurns.coaching`, keyed by a hash of language, question and answer), so a retried or re-run stage only asks for what is missing. A turn the model could not coach gets a deterministic card when the report is built: the verdict from the live assessment, "what a strong answer usually covers" from the question's expected evidence, and no example answer.
- Written in the interview language (see Output language).

### STAR structure

For behavioural questions (the behavioural round, or a behavioural competency) the card shows whether the answer covered Situation, Task, Action and Result. The coaching model reports it; without the model, `evaluation/star.ts` estimates it from cue phrases in English, Hindi and Telugu (a percentage also counts as a result), and the card says it was estimated. The report aggregates it (`structure`: behavioural answers, complete answers, per-part counts and the part most often missing, with a tip). STAR is coaching only: it is not a scored dimension and does not change any weight.

### Delivery (spoken answers)

Voice and video answers carry delivery metrics measured when they are transcribed ([voice](voice.md#delivery-metrics)): words per minute, filler words (count, rate per 100 words, most common), long pauses of 2 s or more (when the speech model returns word timestamps), recording length and hedging phrases. The report's Delivery section sums them (pace weighted by words and time), compares them with the targets in `packages/shared-types/src/delivery.ts` (120–160 words per minute, at most 3 fillers and 2 hedges per 100 words, at most 1 long pause per minute) and gives tips. The UI and the PDF state that delivery **never affects scores**: pace and fillers vary with accent, language, nerves and speech differences, and scoring is based on what was said. Typed interviews have no Delivery section. The compare view adds pace and filler-rate changes when the first and last attempts both have them.

### Peer benchmark

When the report is built, the worker ranks the overall score among other candidates' **original** (revision 0) reports for the same `roleKey` in the last 180 days, one per candidate (their latest), excluding the candidate's own attempts. With fewer than 30 such candidates it tries the role family (`roleFamily`, e.g. `family:ENGINEERING`); with fewer than 30 there too, the benchmark is hidden. Only the percentile (the share of others strictly below), the sample size and the basis are stored; no other candidate's data is. A manual review that changes scores drops the benchmark from the new revision.

## Scoring (`@cbi/scoring-core`)

All of it is pure and deterministic; the same evidence and scores always give the same result.

- **Weights.** The template's scoring policy gives each category a weight (the standard template: technical 35, problem solving 25, communication 15, behavioural 15, domain 10). The blueprint's competency weights split a category's share between its competencies. Categories the blueprint does not cover drop out and the rest are renormalised.
- **Evidence guard.** A dimension with no evidence is not scored ("not assessed"), and never counted as zero. An AI score is clamped to ±25 of the score the evidence strengths imply (mean strength −2…+2 mapped to 0…100). An instruction hidden in an answer therefore cannot lift a score beyond what the evidence supports.
- **Overall.** The weighted mean of the scored dimensions. Below 50 % scored weight there is no overall score (`INSUFFICIENT_EVIDENCE`).
- **Bands.** ≥ 80 interview-ready, ≥ 65 ready with gaps, ≥ 50 developing, otherwise not yet ready.
- **Confidence** (0–1, shown as High ≥ 0.7, Medium ≥ 0.45, Low): 30 % independent questions (8 for full marks), 25 % practical evidence (5), 20 % consistency (evidence within a dimension agrees, and AI scores agree with the evidence), 25 % completeness (scored weight).

The tests check worked examples, order independence, monotonicity (raising one score never lowers the overall), bounds, the guard band under random inputs, and monotone confidence factors.

## What the models see

- Evidence extraction sees the round's questions and answers (as untrusted data) and the competency list. It never sees scores, names, contact details, audio or video. Resume and JD text that shaped the interview was masked before any model saw it ([inputs](inputs-and-role-analysis.md#personal-data-sent-to-models)).
- Dimension scoring sees only that dimension's rubric and its evidence items, never the transcript. So communication is judged from what was said, not how it sounded (design §33).
- Every prompt forbids using protected characteristics, appearance, accent or fluency, and tells the model to ignore instructions inside answers. The regression suite checks both.
- Recommendations are written in the interview language (see Output language); the UI chrome is translated. Hindi and Telugu text (recommendations, titles, quotes) renders in the PDF with embedded fonts (see PDF fonts below).

## Reports

`interviewReports` holds immutable revisions (revision 0 is the AI original; manual review in Phase 10 adds revisions). Only the PDF status and candidate visibility can change after insert. The content contains:

- the header;
- overall score, band, confidence and its factors;
- the summary;
- dimensions with weight, score, rationale and up to four evidence items each, with the question behind them;
- strengths and gaps;
- a round breakdown;
- resume and JD coverage;
- the three-stage plan;
- the change since the previous attempt at the same role (`roleKey`: the matched library role, else the detected title);
- per-question coaching cards, STAR structure, delivery (spoken answers) and the peer benchmark (see Coaching; absent in reports built before them);
- the transcript, if the template's report policy allows it;
- a disclaimer.

The candidate report page shows these as tabs: Summary (readiness, benchmark, summary, skills, strengths and gaps, coding, rounds and coverage), Questions (structure and cards), Delivery (spoken interviews only) and Plan, followed by next steps, sharing, the recording, observations, the transcript and feedback. The PDF has a compact version: per question the verdict, STAR, two points each and the (shortened) example answer; the structure line; the delivery summary with tips; and the benchmark under the overall score.

**PDF fonts.** The PDF embeds static Noto Sans (regular, bold, italic), Noto Sans Devanagari (regular, bold) and Hind Guntur for Telugu (regular, bold) from `apps/worker/assets/fonts` (all SIL OFL 1.1, licence texts alongside; `REPORT_FONT_DIR` overrides the directory). Noto Sans Telugu is not used because fontkit, pdfkit's shaper, throws on common conjuncts such as "శ్రీ" with it. `pdf.ts` splits each string into script runs (`scriptRuns`) and writes them with the matching font on a shared baseline, chained so lines still wrap, so English, Hindi and Telugu can mix in one line. The fonts are committed and shipped through the worker package's `files`; `node infrastructure/scripts/fetch-fonts.mjs` restores them. If they are missing, or shaping throws, the PDF falls back to the standard fonts and `pdfSafe`, which prints non-Latin-1 text as "?".

| Endpoint                                  | Returns                                                                                                                      |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `GET /reports`                            | History, newest first                                                                                                        |
| `GET /reports/:sessionId`                 | The latest candidate-visible revision                                                                                        |
| `GET /reports/:sessionId/pdf`             | The PDF (409 while it is being prepared)                                                                                     |
| `GET /reports/compare?sessions=a,b[,c,d]` | 2–4 attempts at the same role, oldest first, with dimension changes (and pace and filler changes when both ends were spoken) |
| `GET /interviews/:id/progress`            | Evaluation stage and status for the completion screen                                                                        |
| `POST /feedback`, `GET /feedback/:id`     | Usefulness, accuracy and interview quality (1–5), text, "will retake"                                                        |
| `POST /admin/interviews/:id/reprocess`    | New evaluation run for an interview stuck in PROCESSING (`interviews.manage`)                                                |

All candidate endpoints are scoped to the signed-in user; another user's session reads as 404.

## Configuration

| Setting                         | Default                 | Meaning                                                     |
| ------------------------------- | ----------------------- | ----------------------------------------------------------- |
| `WORKER_EVALUATION_CONCURRENCY` | 3                       | Parallel evaluation stages per worker                       |
| `EMAIL_PROVIDER` (worker)       | `disabled`              | `ses` or `smtp` to send report-ready emails from the worker |
| `EMAIL_FROM`, `SMTP_*`, `SES_*` | as the API              | Same meaning as for the API                                 |
| `PUBLIC_CANDIDATE_URL` (worker) | `http://localhost:5173` | Base URL for links in emails                                |
