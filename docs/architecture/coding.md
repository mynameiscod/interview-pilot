# Coding rounds (Phase 9)

A template can include a `CODING` round. The round opens with a problem from the **problem bank**. The candidate writes code in an editor in the interview room, runs it against the visible tests, and submits it. Submitting answers the question, and the interview carries on as usual; any follow-up questions about the solution are ordinary questions.

- Contracts: [`packages/shared-types/src/coding.ts`](../../packages/shared-types/src/coding.ts)
- Judge adapters: [`packages/provider-adapters/src/judge/`](../../packages/provider-adapters/src/judge/)
- API: [`apps/api/src/modules/coding/`](../../apps/api/src/modules/coding/)
- Evaluation: [`apps/worker/src/evaluation/coding.ts`](../../apps/worker/src/evaluation/coding.ts)
- System design rounds (whiteboard, notes and design probes): [system-design.md](system-design.md)

## Code never runs on the interview servers (D9)

Candidate code runs only on an **external judge on a separate host**, through `JudgeAdapter`: `listLanguages`, `submit`, `status` and `result`.

- **Signing.** Every request is signed. The headers `X-CB-Timestamp` and `X-CB-Signature` carry `HMAC-SHA256(secret, "<ts>.<METHOD>.<path>.<sha256(body)>")`. The judge rejects signatures outside a ±5 minute window. `verifyJudgeSignature` is the reference check for the judge side.
- **Adapters.**
  - `codebegun`: the target CodeBegun Judge API (`/v1/languages`, `/v1/submissions`).
  - `judge0`: the interim adapter for a self-hosted Judge0 CE on its own VPS. It uses the batch API with one Judge0 submission per test and base64 payloads, sent and read back in batches of at most `JUDGE0_MAX_BATCH_SIZE` (Judge0's own `MAX_SUBMISSION_BATCH_SIZE`, 20 by default), so a problem with 5 visible and 30 hidden tests goes out as batches of 20 and 15 and the results are merged in test order. Requests carry the HMAC headers for a verifying proxy, plus `X-Auth-Token` when Judge0 authentication is on.
  - `mock`: for development and tests only, and refused when deployed. It **never executes code**. The result comes from markers in the source: `MOCK_PASS_<n>`, `MOCK_COMPILE_ERROR`, `MOCK_TIMEOUT`, `MOCK_RUNTIME_ERROR` and `MOCK_JUDGE_DOWN`. Custom-input runs get a fixed line (`[mock judge] read N characters of input`), never a program's output.
- **Waiting and failure.** `runOnJudge` submits, then polls with backoff for up to 20 seconds. Any transport failure, refusal or timeout becomes `JudgeUnavailableError`. The caller treats that as "the judge is down", never as a failure of the interview.
- **Languages:** Python 3, JavaScript (Node.js), Java, C++, TypeScript, Go, C#, C, Kotlin, Rust and SQL (SQLite). The Judge0 defaults are the Judge0 CE 1.13 ids: 71, 63, 62, 54, 74, 60, 51, 50, 78, 73 and 82. Self-hosted installs with newer compilers use other ids (for example TypeScript 5.0.3 is 94, Go 1.18 is 95), so any of them can be overridden with `JUDGE0_LANGUAGE_IDS=typescript=94,go=95` or the **Language ids** setting of the Judge0 integration (System → Integrations). The judge only offers languages whose id the install has. Monaco registers a tokenizer for each (a 1–4 KB lazy chunk each); its ids are the language names.
- **Test comparison.** Each judge test has a `compare` mode: `EXACT` (the judge compares, as before), `UNORDERED_LINES` (the judge only runs it; `toRunResult` compares the output lines after sorting) and `NONE` (custom input, never compared).
- **SQL problems** have a `sql` setting: a schema script and whether row order matters. The schema and each test's `input` (its rows, as `INSERT` statements) are sent as a **prelude** that the judge runs before the candidate's query in the same program (Judge0 prepends it to the source); the output is SQLite's list mode (columns separated by `|`). A SQL problem uses the `sql` language only, and other problems never offer it. Coding rounds ask SQL problems only when the round targets a SQL competency, may ask them when the role mentions SQL, and never otherwise.

## Problem bank

`problems` holds append-only versions per `key`, with one active version per key. Each version holds:

- the title, statement, difficulty, topic tags, optional company-style tags (generic labels only, such as `product-company`, `service-company` or `fintech`, never company names) and languages;
- starter code for each language (and, for SQL problems, the schema and the row-order rule);
- 1 to 5 **visible** tests and 1 to 30 **hidden** tests, as stdin and expected stdout;
- CPU and memory limits.

**Hidden tests never leave the server.** The workspace reports only how many there are, and run results for hidden tests carry only a verdict: no input and no output.

**Forty original problems are seeded** (13 easy, 17 medium, 10 hard; `packages/db/src/seed/problem-bank/`) across arrays and strings, hashing, two pointers, sliding windows, stacks and queues, trees, graphs, heaps, dynamic programming, intervals and SQL (joins, grouping, window functions). Each has 1–2 visible tests, 8 or more hidden tests with edge cases, starter code for every language and a **reference solution** (Python 3, or a SQLite query). The expected outputs come from the references, and when the bank was generated every test was also checked against an independent brute-force solution. `problem-bank.test.ts` re-runs every reference on every test with a local Python 3 (`verify_references.py`; skipped when no Python is installed — it never runs on a server), and a worker test runs every problem through the judge harness (preludes, unordered rows, hidden-test redaction).

The seed is **versioned**: each seed problem has a `revision`. A key with no versions gets version 1; a key whose versions all came from an older seed revision gets the new revision as its next version (active if the key had an active version); a key with any admin-created version is never touched. Admins with `library.manage` add versions and activate them under **Library → Coding problems** (including SQL settings and company-style tags).

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
- The submit request waits for the judge (up to 20 seconds) and for the answer to be saved, but not for the AI: the answer's assessment and the next question follow in the background, as for any answer (see [A turn](live-interview.md#a-turn)), and arrive in the room as events.
- **Recoverable.** The submission is saved before the question is answered. If answering fails (the interview was busy, a restart), the submission stays and submitting again answers the question with the saved code (idempotent per question: `clientMsgId` `coding-<questionId>`). The editor accepts saves, runs and submits in the states the answer path accepts: `ACTIVE`, and `RECONNECTING`, where the submission resumes the interview first.
- Runs and submissions share the `coding` rate limit: 60 per 10 minutes per user.

### Run with my input

`POST …/custom-run` (`{language, code, stdin}`, stdin up to 16 KB) runs the code once on the judge with the candidate's own input; for SQL problems the input is extra statements run after the schema. The output, error output and compiler output are shown as they are: nothing is compared, it is never a test, and it does not change the last run. The code is saved with it, the attempt counts `customRunCount`, and it has its own limit (`codingCustom`, 30 per 10 minutes per user). A judge that is down gives the usual 503 `JUDGE_UNAVAILABLE` notice.

### AI-allowed rounds

A template's coding round can allow an **AI assistant** (`aiAssist: {enabled, maxTurns, allowFullSolutions}`; off by default; admin: Library → Templates). The candidate sees a banner saying the assistant is allowed and that the conversation is saved and reviewed, and a chat panel beside the problem.

- `POST …/assist` (`{language, code, message}`) saves the code and asks the `coding.assist` feature through the AI router (output capped at 700 tokens) with the problem, the code and the last messages as data. The prompt tells the model to guide rather than solve; when `allowFullSolutions` is false, code blocks or unfenced code longer than 12 lines are also removed from the reply (`redactLongCode`) and the reply is marked.
- Each question allows `maxTurns` messages (1–30, default 12; 429 `QUOTA_EXCEEDED` after that, guarded atomically); an unavailable model leaves a marked reply and does not use a turn. Messages have their own limit (`codingAssist`, 40 per 10 minutes per user). Rounds without the assistant answer 403 `FEATURE_DISABLED`.
- Every message is kept on the attempt with the code at the time; admins see the conversation in interview review.
- Evaluation scores an **AI collaboration** panel (prompt quality, verification of AI output, independence) with `evaluation.aiCollaboration`, keeping only quotes that appear in the material. It is shown in the report and PDF beside the dimensions and is **not** part of the overall score; the coding section marks AI-allowed problems.

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

| Variable                    | Where       | Notes                                                                                     |
| --------------------------- | ----------- | ----------------------------------------------------------------------------------------- |
| `JUDGE_PROVIDER`            | API, worker | `mock` (default; development and test only), `judge0` or `codebegun`                      |
| `JUDGE_BASE_URL`            | API, worker | For example `https://judge.internal.example`; required for a real judge                   |
| `JUDGE_HMAC_SECRET`         | API, worker | At least 32 characters, shared with the judge or its proxy                                |
| `JUDGE0_AUTH_TOKEN`         | API, worker | Judge0's `X-Auth-Token`, when enabled                                                     |
| `JUDGE0_MAX_BATCH_SIZE`     | API, worker | Judge0's `MAX_SUBMISSION_BATCH_SIZE` (default 20); tests are sent in batches of this size |
| `JUDGE0_LANGUAGE_IDS`       | API, worker | Optional `language=id,…` overrides for this Judge0 install (admin setting: Language ids)  |
| `CODE_SIMILARITY_THRESHOLD` | worker      | Campaign submissions at least this similar (0.5–1, default 0.8) are flagged for review    |

**Deploying Judge0 (interim).** Run it on a **separate** VPS, never on the interview host. Put a proxy in front of it that checks the HMAC headers, and don't expose Judge0 directly to the internet. Turn on its own authentication, and keep its resource limits at least as strict as the problem limits.

## Manual browser checks

Run these on Chrome, Edge, Firefox and Safari (desktop), and on one phone:

1. Monaco loads from the app's own origin (no CDN requests), its worker starts, and syntax colouring works for Python, JavaScript, Java and C++.
2. Ctrl/Cmd+Enter runs the code, and Ctrl/Cmd+Shift+Enter opens the submit confirmation, from inside the editor.
3. The save status updates while typing, and leaving the editor or switching tabs saves. Going offline shows "Not saved — retrying", and it recovers.
4. Judge down (use `MOCK_JUDGE_DOWN` with the mock judge): Run shows the notice, and Submit shows the "reviewed from the code" message.
5. In voice and video interviews, the problem is read aloud and no microphone or answer box appears for the coding question.
6. Under 768 px the layout stacks and the laptop banner can be dismissed. Screen readers announce results and the confirmation dialog.
7. When time runs out, unsaved code is saved on the way out, and the report shows "Not submitted before time ran out" with the judged result.

Known behaviour:

- Monaco is a lazy 745 KB (gzip) chunk; Vite warns about its size.
- Switching languages replaces the code with the new language's starter code, after a confirmation.
- The report's transcript shows the candidate's own code for coding answers.

## Code similarity in campaigns

After a campaign interview's report is built, the worker (`evaluation.code_similarity`, one job per session and run) compares each of its coding submissions with every other submission to the same problem (any version of the key) in the same language within the campaign, skipping the candidate's own.

- **Method** (`apps/worker/src/integrity/code-similarity.ts`): comments are removed; the code becomes a token stream where names are `V`, numbers `N` and strings `S` (keywords and operators stay; SQL keywords case-insensitively); hashes of every 7-token k-gram are **winnowed** (the minimum of each window of 4) into fingerprints. Fingerprints of the problem's starter code are removed, and submissions with fewer than 12 of their own are not compared. Similarity is the Jaccard index of the fingerprint sets; containment is the share of the smaller one found in the other.
- Pairs at or above `CODE_SIMILARITY_THRESHOLD` (default 0.8) are stored once per pair in `codeSimilarityFlags` (refreshed on a re-run) and listed in admin interview review as an **integrity observation**, with a link to the other interview. They are never scored and are erased with either candidate's account.
