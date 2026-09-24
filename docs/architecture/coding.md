# Coding rounds (Phase 9)

A template can include a `CODING` round. The round opens with a problem from the **problem bank**. The candidate writes code in an editor in the interview room, runs it against the visible tests, and submits it. Submitting answers the question, and the interview carries on as usual; any follow-up questions about the solution are ordinary questions.

- Contracts: [`packages/shared-types/src/coding.ts`](../../packages/shared-types/src/coding.ts)
- Judge adapters: [`packages/provider-adapters/src/judge/`](../../packages/provider-adapters/src/judge/)
- API: [`apps/api/src/modules/coding/`](../../apps/api/src/modules/coding/)
- Evaluation: [`apps/worker/src/evaluation/coding.ts`](../../apps/worker/src/evaluation/coding.ts)

## Code never runs on the interview servers (D9)

Candidate code runs only on an **external judge on a separate host**, through `JudgeAdapter`: `listLanguages`, `submit`, `status` and `result`.

- **Signing.** Every request is signed. The headers `X-CB-Timestamp` and `X-CB-Signature` carry `HMAC-SHA256(secret, "<ts>.<METHOD>.<path>.<sha256(body)>")`. The judge rejects signatures outside a ±5 minute window. `verifyJudgeSignature` is the reference check for the judge side.
- **Adapters.**
  - `codebegun`: the target CodeBegun Judge API (`/v1/languages`, `/v1/submissions`).
  - `judge0`: the interim adapter for a self-hosted Judge0 CE on its own VPS. It uses the batch API with one Judge0 submission per test and base64 payloads. Requests carry the HMAC headers for a verifying proxy, plus `X-Auth-Token` when Judge0 authentication is on.
  - `mock`: for development and tests only, and refused when deployed. It **never executes code**. The result comes from markers in the source: `MOCK_PASS_<n>`, `MOCK_COMPILE_ERROR`, `MOCK_TIMEOUT` and `MOCK_JUDGE_DOWN`.
- **Waiting and failure.** `runOnJudge` submits, then polls with backoff for up to 20 seconds. Any transport failure, refusal or timeout becomes `JudgeUnavailableError`. The caller treats that as "the judge is down", never as a failure of the interview.
- **Languages:** Python 3, JavaScript (Node.js), Java and C++. Judge0 CE language ids are 71, 63, 62 and 54.

## Problem bank

`problems` holds append-only versions per `key`, with one active version per key. Each version holds:

- the title, statement, difficulty, tags and languages;
- starter code for each language;
- 1 to 5 **visible** tests and 1 to 30 **hidden** tests, as stdin and expected stdout;
- CPU and memory limits.

**Hidden tests never leave the server.** The workspace reports only how many there are, and run results for hidden tests carry only a verdict: no input and no output.

Four problems are seeded: two easy and two medium. Admins with `library.manage` add versions and activate them under **Library → Coding problems**.

A coding round gets a problem at the round's difficulty (or any problem if none matches) that the candidate hasn't seen in their last 10 attempts. The choice is deterministic for each interview and round. If the bank is empty, the round asks an ordinary question.

## The room

`LiveQuestion.coding` marks a coding question. The room shows the problem and an editor instead of the answer box. This holds in every mode; in voice and video interviews the question is still read aloud.

| Endpoint                                 | What it does                                                                                                             |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `GET /interviews/:id/coding/:questionId` | The workspace: problem, code, language, last run and submission                                                          |
| `PUT …`                                  | Autosave (the browser saves every 5 s and on blur); up to 64 KB                                                          |
| `POST …/run`                             | Visible tests only. **503 `JUDGE_UNAVAILABLE`** when the judge can't run the code; the code is saved anyway              |
| `POST …/submit`                          | All tests. The result is recorded and the question is **answered** (a summary plus the code), and the interview moves on |

- Typed socket answers to a coding question are refused.
- Submitting twice does nothing the second time.
- Runs and submissions share the `coding` rate limit: 60 per 10 minutes per user.

## When the judge is down

- **Run:** the room shows a non-blocking notice. The candidate keeps working.
- **Submit:** the code is still recorded (`judgeUnavailable: true`), and the question is answered with a note that the code wasn't run. The interview carries on.
- **Evaluation:** no judge evidence is created. Any evidence the AI extracts from reading that code is capped at **0.5 confidence**, with an uncertainty note, so the report's confidence reflects it.
- **Report:** the Coding section says the code wasn't run and was reviewed from the code.

## Evaluation

- **Unsubmitted code.** If time runs out, or the interview ends with code in the editor that differs from the starter, the worker judges it during `FINALIZE_TRANSCRIPT`. It is recorded as an automatic submission, and evidence extraction reads it, labelled as not submitted.
- **Judge evidence.** Each judged solution adds one deterministic evidence item for the question's competency (falling back to the first technical competency), with confidence 0.9. The strength comes from the pass rate:

  | Tests passed                     | Strength |
  | -------------------------------- | -------- |
  | All                              | +2       |
  | 75% or more                      | +1       |
  | 40% or more                      | 0        |
  | More than none                   | −1       |
  | None, or the code didn't compile | −2       |

- **Reading the code.** The AI extracts evidence from the submission text as for any answer: approach, clarity and explanations.
- **Report and PDF.** A Coding section lists, for each problem, its title, difficulty, language, tests passed, and whether the code was submitted or judged unavailable.

## Configuration

| Variable            | Where       | Notes                                                                   |
| ------------------- | ----------- | ----------------------------------------------------------------------- |
| `JUDGE_PROVIDER`    | API, worker | `mock` (default; development and test only), `judge0` or `codebegun`    |
| `JUDGE_BASE_URL`    | API, worker | For example `https://judge.internal.example`; required for a real judge |
| `JUDGE_HMAC_SECRET` | API, worker | At least 32 characters, shared with the judge or its proxy              |
| `JUDGE0_AUTH_TOKEN` | API, worker | Judge0's `X-Auth-Token`, when enabled                                   |

**Deploying Judge0 (interim).** Run it on a **separate** VPS, never on the interview host. Put a proxy in front of it that checks the HMAC headers, and don't expose Judge0 directly to the internet. Turn on its own authentication, and keep its resource limits at least as strict as the problem limits.
