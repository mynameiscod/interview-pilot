# Evaluation and readiness reports

Phase 5 turns a finished interview into an evidence-backed readiness report: evidence first, deterministic scoring, AI-written recommendations, a PDF and an email. This page describes the pipeline, the scoring rules and the report. The AI regression suite is described in [AI evaluation regression](../ai/evaluation-regression.md).

## When it runs

An interview reaches `PROCESSING` when it finishes, when the candidate ends it early, or when a meaningful paused interview expires ([live interview](live-interview.md)). The engine then emits `ENQUEUE_EVALUATION`. The API calls `beginEvaluation`, which starts run 1 exactly once, and enqueues the first stage on the `evaluation` queue. If that enqueue is lost, the worker's sweep starts any `PROCESSING` session that has no evaluation run after 30 seconds.

## The pipeline

One BullMQ job per stage, id `evaluation-<session>-<stage>-<run>`, so a duplicate is a no-op. Each finished stage enqueues the next one. Progress is recorded on the session (`processing: {run, stage, status, completed[], attempts, error}`), which the completion screen polls.

| #   | Stage                 | Does                                                                                                                                                                                       | If the AI is unavailable                                             |
| --- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| 1   | `FINALIZE_TRANSCRIPT` | Checks the transcript is complete (turns are already final once the session is `PROCESSING`)                                                                                               | —                                                                    |
| 2   | `EXTRACT_EVIDENCE`    | Per round, `evaluation.extractEvidence` turns answers into evidence items: claim, strength −2…+2, confidence, practical, quote. Items naming unknown questions or competencies are dropped | The live turn assessments become evidence (STRONG +2 … NO_ANSWER −2) |
| 3   | `SCORE_DIMENSIONS`    | Per competency with evidence, `evaluation.scoreDimension` scores 0–100 **from that competency's evidence and rubric only**                                                                 | The score comes from the evidence strengths alone (`fallback`)       |
| 4   | `AGGREGATE`           | Deterministic, in `@cbi/scoring-core`: evidence guard, weighted overall, confidence, band. Writes `interviewScores` revision 0                                                             | —                                                                    |
| 5   | `RECOMMENDATIONS`     | `report.recommendations`: summary, strengths, gaps and the 24-hour / 3-day / 7-day plan                                                                                                    | Score-based recommendations                                          |
| 6   | `BUILD_REPORT`        | Writes `interviewReports` revision 0 and moves the session to `REPORT_READY`                                                                                                               | —                                                                    |
| 7   | `RENDER_PDF`          | Renders the PDF (pdfkit) to private storage                                                                                                                                                | —                                                                    |
| 8   | `NOTIFY`              | Emails "Your report is ready" with a link, when worker email is configured and the address is verified                                                                                     | —                                                                    |

- **A report is always produced.** Every AI step has a deterministic fallback, so a provider outage slows a report down (retries and timeouts) but never stops it.
- **Failures keep everything.** A stage that still fails after 3 attempts is marked `FAILED`; the transcript, evidence and earlier results stay, and the session stays in `PROCESSING`. An operations admin re-runs it with `POST /admin/interviews/:id/reprocess` (a new run, audited). The sweep re-queues stages that stall for 10 minutes.
- **Stage outputs are idempotent.** Evidence is replaced per run and round, and score and report revision 0 are written once (unique index).
- **The report is visible before the PDF.** `REPORT_READY` happens at stage 6; the PDF and email follow.

## Scoring (`@cbi/scoring-core`)

All of it is pure and deterministic; the same evidence and scores always give the same result.

- **Weights.** The template's scoring policy gives each category a weight (the standard template: technical 35, problem solving 25, communication 15, behavioural 15, domain 10). The blueprint's competency weights split a category's share between its competencies. Categories the blueprint does not cover drop out and the rest are renormalised.
- **Evidence guard.** A dimension with no evidence is not scored ("not assessed"), and never counted as zero. An AI score is clamped to ±25 of the score the evidence strengths imply (mean strength −2…+2 mapped to 0…100). An instruction hidden in an answer therefore cannot lift a score beyond what the evidence supports.
- **Overall.** The weighted mean of the scored dimensions. Below 50 % scored weight there is no overall score (`INSUFFICIENT_EVIDENCE`).
- **Bands.** ≥ 80 interview-ready, ≥ 65 ready with gaps, ≥ 50 developing, otherwise not yet ready.
- **Confidence** (0–1, shown as High ≥ 0.7, Medium ≥ 0.45, Low): 30 % independent questions (8 for full marks), 25 % practical evidence (5), 20 % consistency (evidence within a dimension agrees, and AI scores agree with the evidence), 25 % completeness (scored weight).

The tests check worked examples, order independence, monotonicity (raising one score never lowers the overall), bounds, the guard band under random inputs, and monotone confidence factors.

## What the models see

- Evidence extraction sees the round's questions and answers (as untrusted data) and the competency list. It never sees scores, names, contact details, audio or video.
- Dimension scoring sees only that dimension's rubric and its evidence items, never the transcript. So communication is judged from what was said, not how it sounded (design §33).
- Every prompt forbids using protected characteristics, appearance, accent or fluency, and tells the model to ignore instructions inside answers. The regression suite checks both.
- Report text is generated in English for now, so the PDF can use standard fonts; the UI chrome is translated.

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
- the transcript, if the template's report policy allows it;
- a disclaimer.

| Endpoint                                  | Returns                                                                       |
| ----------------------------------------- | ----------------------------------------------------------------------------- |
| `GET /reports`                            | History, newest first                                                         |
| `GET /reports/:sessionId`                 | The latest candidate-visible revision                                         |
| `GET /reports/:sessionId/pdf`             | The PDF (409 while it is being prepared)                                      |
| `GET /reports/compare?sessions=a,b[,c,d]` | 2–4 attempts at the same role, oldest first, with dimension changes           |
| `GET /interviews/:id/progress`            | Evaluation stage and status for the completion screen                         |
| `POST /feedback`, `GET /feedback/:id`     | Usefulness, accuracy and interview quality (1–5), text, "will retake"         |
| `POST /admin/interviews/:id/reprocess`    | New evaluation run for an interview stuck in PROCESSING (`interviews.manage`) |

All candidate endpoints are scoped to the signed-in user; another user's session reads as 404.

## Configuration

| Setting                         | Default                 | Meaning                                                     |
| ------------------------------- | ----------------------- | ----------------------------------------------------------- |
| `WORKER_EVALUATION_CONCURRENCY` | 3                       | Parallel evaluation stages per worker                       |
| `EMAIL_PROVIDER` (worker)       | `disabled`              | `ses` or `smtp` to send report-ready emails from the worker |
| `EMAIL_FROM`, `SMTP_*`, `SES_*` | as the API              | Same meaning as for the API                                 |
| `PUBLIC_CANDIDATE_URL` (worker) | `http://localhost:5173` | Base URL for links in emails                                |
