/**
 * AI regression runner (pnpm --filter @cbi/worker ai:eval).
 *
 *   --mode=full|structure   full (default): check every expectation against the
 *                           configured models; structure: only check that each
 *                           step returns valid output (works with the mock).
 *   --suite=regression|calibration|tailoring|all
 *                           regression (default): behaviour fixtures;
 *                           calibration: human-labelled answers (reports
 *                           agreement with the labels); tailoring: resume
 *                           tailoring must not invent employers or metrics;
 *                           all: every suite
 *   --only=id1,id2          run selected fixtures
 *   --repeat=N              run each fixture N times and check score stability
 *   --out=path.json         write the full report as JSON
 *   --seed                  first seed an empty eval database (indexes, AI
 *                           catalog, library prompts) and store provider keys
 *                           from AI_EVAL_{ANTHROPIC,OPENAI,GEMINI}_API_KEY.
 *                           Refused unless the database name contains
 *                           "eval" or "test" (nightly CI).
 *
 * Uses the same MONGODB_URI/REDIS_URL/AI settings as the worker: models,
 * routes, keys and active prompts come from the database. Real models are
 * billed. Exit code 1 when any check fails.
 */
import { writeFile } from 'node:fs/promises';
import { buildAiRuntime } from '@cbi/ai-runtime';
import { createLogger, loadEnv, workerEnvSchema } from '@cbi/config';
import { connectMongo, createRedis, disconnectMongo } from '@cbi/db';
import { calibrationFixtures } from './calibration.js';
import { EVAL_FIXTURES, type EvalFixture } from './fixtures.js';
import { formatReport, runEvalSuite, withExtraResults, type EvalMode } from './runner.js';
import { seedableDatabase, seedEvalDatabase } from './seed.js';
import { runTailoringSuite } from './tailoring-eval.js';
import { TAILORING_FIXTURES } from './tailoring-fixtures.js';

function arg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((a) => a.startsWith(prefix))?.slice(prefix.length);
}

async function main() {
  const env = loadEnv(workerEnvSchema);
  const logger = createLogger({
    service: 'ai-eval',
    level: 'warn',
    version: env.APP_VERSION,
    env: env.APP_ENV,
  });
  const mode = (arg('mode') ?? 'full') as EvalMode;
  if (mode !== 'full' && mode !== 'structure') throw new Error('--mode must be full or structure');
  const only = arg('only')
    ?.split(',')
    .map((s) => s.trim());
  const suite = arg('suite') ?? 'regression';
  const suites: Record<string, EvalFixture[]> = {
    regression: EVAL_FIXTURES,
    calibration: calibrationFixtures(),
    tailoring: [],
    all: [...EVAL_FIXTURES, ...calibrationFixtures()],
  };
  if (!suites[suite]) {
    throw new Error('--suite must be regression, calibration, tailoring or all');
  }
  const selected = suites[suite];
  const fixtures = only ? selected.filter((f) => only.includes(f.id)) : selected;
  // Resume tailoring fixtures (no-fabrication checks) run with `tailoring` and `all`.
  const tailoring =
    suite === 'tailoring' || suite === 'all'
      ? TAILORING_FIXTURES.filter((f) => !only || only.includes(f.id))
      : [];
  if (fixtures.length === 0 && tailoring.length === 0) {
    throw new Error(`no fixtures match ${only?.join(',')}`);
  }

  const redis = createRedis(env.REDIS_URL, logger);
  await Promise.all([
    connectMongo({ uri: env.MONGODB_URI, autoIndex: false, logger }),
    redis.connect(),
  ]);
  try {
    const ai = buildAiRuntime({ env, logger, redis });
    if (process.argv.includes('--seed')) {
      if (!seedableDatabase(env.MONGODB_URI)) {
        throw new Error('--seed needs a database whose name contains "eval" or "test"');
      }
      const keyed = await seedEvalDatabase(ai);
      process.stdout.write(`seeded eval database; keys for: ${keyed.join(', ') || 'none'}\n`);
    }
    const report = withExtraResults(
      await runEvalSuite({ ai, logger }, fixtures, {
        mode,
        repeat: Number(arg('repeat') ?? 1),
      }),
      await runTailoringSuite({ ai, logger }, tailoring, mode),
    );
    process.stdout.write(`${formatReport(report)}\n`);
    const out = arg('out');
    if (out) await writeFile(out, JSON.stringify(report, null, 2));
    process.exitCode = report.passed ? 0 : 1;
  } finally {
    await Promise.allSettled([disconnectMongo(), redis.quit()]);
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(2);
});
