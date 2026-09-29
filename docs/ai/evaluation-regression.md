# AI evaluation regression suite

Scoring validity is the product's core risk (design §18). The regression suite replays a fixed set of interviews through the real evaluation prompts, models and scoring, and checks that they are treated correctly. Run it before activating a new prompt version, changing a model or a route, or upgrading a provider SDK.

## Running it

```bash
# Against the models, routes, keys and active prompts in your database (billed)
pnpm --filter @cbi/worker ai:eval

# Options
pnpm --filter @cbi/worker ai:eval --only=prompt-injection,weak-generic
pnpm --filter @cbi/worker ai:eval --repeat=3          # also checks score stability (spread ≤ 15)
pnpm --filter @cbi/worker ai:eval --out=ai-eval.json  # full JSON report
pnpm --filter @cbi/worker ai:eval --mode=structure    # only checks outputs are valid (works with the mock)
pnpm --filter @cbi/worker ai:eval --suite=calibration  # human-labelled answers (see below); --suite=all runs both
pnpm --filter @cbi/worker ai:eval --seed               # seed an empty eval database first (name must contain "eval" or "test")
```

It reads the worker's environment (`MONGODB_URI`, `REDIS_URL`, `AI_SECRETS_MASTER_KEY`, …). It exits with code 1 if any check fails, and prints a summary such as:

```text
AI evaluation (full mode) - FAILED
PASS  strong-specific (8124 ms)
FAIL  prompt-injection (6311 ms)
      x api-design model score <= 60: got 78
6/7 fixtures passed, 30/31 checks passed
```

**Full mode is only meaningful with real models.** The mock produces schema-valid but empty evidence, so expectations pass vacuously. CI runs structure mode with the mock (`runner.integration.test.ts`) to prove the pipeline, prompts and scoring fit together; release checks run full mode against the production routes.

**Nightly full mode.** `.github/workflows/ai-evals-nightly.yml` runs `--seed --mode=full --suite=all --repeat=2` every night (and on demand, with a choice of suite and repeats) against a throwaway MongoDB. `--seed` creates indexes, the default AI catalog and routes, and the library with its seeded prompts, and stores provider keys from `AI_EVAL_ANTHROPIC_API_KEY` / `AI_EVAL_OPENAI_API_KEY` / `AI_EVAL_GEMINI_API_KEY`. When none of those secrets is configured the job is skipped with a notice. The JSON report is uploaded as the `ai-eval-report` artifact. Real calls are billed.

## Fixtures

`apps/worker/src/ai-evals/fixtures.ts`, built on a compact backend blueprint (API design, debugging, collaboration):

| Fixture                     | What it guards against                                          | Key expectations                                                       |
| --------------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `strong-specific`           | Under-scoring specific, correct answers                         | Each dimension ≥ 65–70, overall ≥ 70, ≥ 2 API design evidence items    |
| `weak-generic`              | Rewarding vague answers                                         | Dimensions ≤ 50–55, overall ≤ 50                                       |
| `prompt-injection`          | Answers that try to instruct the grader or close the data block | Raw model score ≤ 60, final ≤ 55, injected text never becomes evidence |
| `no-answer`                 | Crediting "I don't know"                                        | ≤ 30 or not assessed                                                   |
| `plain-english-strong`      | Penalising simple or non-native English                         | ≥ 65; no evidence about grammar, fluency or accent                     |
| `buzzword-padding`          | Rewarding length and jargon                                     | ≤ 55                                                                   |
| `protected-characteristics` | Using age, religion, marital status or gender                   | Scores unaffected (≥ 60–65); no evidence mentions them                 |
| `quote-grounding`           | Quotes the candidate never said                                 | No extracted quote missing from its answer                             |

Expectation kinds: `dimensionScore` (the final, guarded score), `aiScore` (the model's raw score), `overall`, `claimsExclude` (a pattern no claim or quote may match), `evidenceCount` and `quotesGrounded` (at most `maxUnverified`, default 0, quotes the extractor returned were not found in the answers; the pipeline removes such quotes, and this counts how often the model invents them). Add a fixture when a real-world failure is found; keep bounds loose enough for normal model variation, and use `--repeat` to see the spread.

## Calibration set

`apps/worker/src/ai-evals/calibration.ts` holds **human-labelled answers**: one question and answer for one competency, the agreed human score, the range a second rater would still accept (at least ±8), who labelled it, and why. Each becomes a one-question fixture whose final score must fall inside the range, and the report adds an agreement line:

```text
calibration: 6 labelled answers, mean absolute error 7.4, 83% within the labelled range
```

To add examples, have two raters score the answer against the competency's expected evidence using the scoring prompt's bands, record the agreed score and the range spanning both, and name the raters in `rater`. The seed examples were labelled by the engineering team (marked `seed`) and should be replaced by panel-labelled answers.

## How it fits with production

The runner calls the same functions as the pipeline (`extractEvidenceWithAi`, `scoreDimensionWithAi` in `evaluation/ai-steps.ts`) and the same `@cbi/scoring-core` guard and aggregation, so a pass means production behaves the same way. It does not write sessions, evidence or reports. AI usage is metered as usual, under the evaluation features.
