import type { AppEnv, DependencyCheck, ReadinessResponse } from '@cbi/shared-types';

/** A dependency probe resolves when healthy and rejects (or times out) otherwise. */
export type DependencyProbe = () => Promise<unknown>;

export interface ReadinessOptions {
  env: AppEnv;
  probes: Record<string, DependencyProbe>;
  /** True while the process is draining for shutdown; readiness must then fail. */
  isDraining: () => boolean;
  timeoutMs?: number;
}

async function runProbe(probe: DependencyProbe, timeoutMs: number): Promise<DependencyCheck> {
  const started = performance.now();
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      probe(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
      }),
    ]);
    return { status: 'up', latencyMs: Math.round(performance.now() - started) };
  } catch (err) {
    // Only a short, fixed reason: driver errors can contain hosts or credentials.
    const reason = err instanceof Error && err.message === 'timeout' ? 'timeout' : 'unreachable';
    return { status: 'down', latencyMs: Math.round(performance.now() - started), reason };
  } finally {
    clearTimeout(timer);
  }
}

export async function checkReadiness(opts: ReadinessOptions): Promise<ReadinessResponse> {
  const timeoutMs = opts.timeoutMs ?? 2000;
  const entries = await Promise.all(
    Object.entries(opts.probes).map(
      async ([name, probe]) => [name, await runProbe(probe, timeoutMs)] as const,
    ),
  );
  const checks: Record<string, DependencyCheck> = Object.fromEntries(entries);
  if (opts.isDraining()) {
    checks.process = { status: 'down', reason: 'draining' };
  }
  const allUp = Object.values(checks).every((c) => c.status === 'up');
  return { status: allUp ? 'ready' : 'not_ready', env: opts.env, checks };
}
