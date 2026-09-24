/**
 * AI regression runner (pnpm --filter @cbi/worker ai:eval).
 *
 *   --mode=full|structure   full (default): check every expectation against the
 *                           configured models; structure: only check that each
 *                           step returns valid output (works with the mock).
 *   --only=id1,id2          run selected fixtures
 *   --repeat=N              run each fixture N times and check score stability
 *   --out=path.json         write the full report as JSON
 *
 * Uses the same MONGODB_URI/REDIS_URL/AI settings as the worker: models,
 * routes, keys and active prompts come from the database. Real models are
 * billed. Exit code 1 when any check fails.
 */
import { writeFile } from 'node:fs/promises';
import { buildAiRuntime } from '@cbi/ai-runtime';
import { createLogger, loadEnv, workerEnvSchema } from '@cbi/config';
import { connectMongo, createRedis, disconnectMongo } from '@cbi/db';
import { EVAL_FIXTURES } from './fixtures.js';
import { formatReport, runEvalSuite, type EvalMode } from './runner.js';

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
  const fixtures = only ? EVAL_FIXTURES.filter((f) => only.includes(f.id)) : EVAL_FIXTURES;
  if (fixtures.length === 0) throw new Error(`no fixtures match ${only?.join(',')}`);

  const redis = createRedis(env.REDIS_URL, logger);
  await Promise.all([
    connectMongo({ uri: env.MONGODB_URI, autoIndex: false, logger }),
    redis.connect(),
  ]);
  try {
    const ai = buildAiRuntime({ env, logger, redis });
    const report = await runEvalSuite({ ai, logger }, fixtures, {
      mode,
      repeat: Number(arg('repeat') ?? 1),
    });
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
