import { InterviewSessionModel, mongoose, type Redis } from '@cbi/db';
import {
  QueueName,
  WORKER_HEARTBEAT_KEY_PREFIX,
  type FailedJob,
  type SystemHealth,
} from '@cbi/shared-types';
import type { AuditService } from '../../lib/audit.js';
import { AppError } from '../../lib/errors.js';
import type { QueueAdmin } from '../../lib/queue-admin.js';
import type { ClientContext } from '../../lib/request-context.js';
import type { SettingsService } from './ops.service.js';

/** An interview still PROCESSING after this long is reported as stuck. */
export const STUCK_PROCESSING_MS = 30 * 60 * 1000;

export function queueName(value: string): QueueName {
  const names = Object.values(QueueName) as string[];
  if (!names.includes(value)) throw AppError.notFound('Queue not found');
  return value as QueueName;
}

async function timed(fn: () => Promise<unknown>) {
  const t = performance.now();
  try {
    await fn();
    return { ok: true, latencyMs: Math.round(performance.now() - t) };
  } catch {
    return { ok: false, latencyMs: null };
  }
}

export function createSystemService(deps: {
  redis: Redis;
  queues: QueueAdmin;
  audit: AuditService;
  settings: SettingsService;
  version: string;
  env: string;
  now?: () => Date;
}) {
  const now = deps.now ?? (() => new Date());

  async function heartbeats() {
    const keys: string[] = [];
    let cursor = '0';
    do {
      const [next, batch] = await deps.redis.scan(
        cursor,
        'MATCH',
        `${WORKER_HEARTBEAT_KEY_PREFIX}*`,
        'COUNT',
        100,
      );
      cursor = next;
      keys.push(...batch);
    } while (cursor !== '0' && keys.length < 500);
    const values = keys.length ? await deps.redis.mget(keys) : [];
    return values.flatMap((raw) => {
      try {
        const hb = JSON.parse(raw ?? '') as {
          workerId: string;
          at: string;
          version?: string;
          queues?: string[];
        };
        return [
          {
            workerId: hb.workerId,
            at: new Date(hb.at).toISOString(),
            version: hb.version ?? null,
            queues: hb.queues ?? [],
            ageSec: Math.max(0, Math.round((now().getTime() - Date.parse(hb.at)) / 1000)),
          },
        ];
      } catch {
        return [];
      }
    });
  }

  return {
    async health(): Promise<SystemHealth> {
      const [mongo, redis, workers, queues, live, processing, stuck, maintenance] =
        await Promise.all([
          timed(() => mongoose.connection.db!.admin().ping()),
          timed(() => deps.redis.ping()),
          heartbeats(),
          deps.queues.counts().catch(() => []),
          InterviewSessionModel.countDocuments({ live: true }),
          InterviewSessionModel.countDocuments({ state: 'PROCESSING' }),
          InterviewSessionModel.countDocuments({
            state: 'PROCESSING',
            updatedAt: { $lt: new Date(now().getTime() - STUCK_PROCESSING_MS) },
          }),
          deps.settings.get('maintenance'),
        ]);
      return {
        version: deps.version,
        env: deps.env,
        dependencies: [
          { name: 'mongodb', ...mongo },
          { name: 'redis', ...redis },
        ],
        workers: workers.sort((a, b) => a.workerId.localeCompare(b.workerId)),
        queues,
        sessions: { live, processing, stuck },
        maintenance,
      };
    },

    queues: () => deps.queues.counts(),

    async failed(name: string, limit: number): Promise<FailedJob[]> {
      return deps.queues.failed(queueName(name), limit);
    },

    async retry(name: string, jobId: string, reason: string, actorId: string, ctx: ClientContext) {
      const queue = queueName(name);
      if (!/^[\w:.-]{1,200}$/.test(jobId)) throw AppError.notFound('Job not found');
      const ok = await deps.queues.retry(queue, jobId);
      if (!ok) throw AppError.notFound('No failed job with that id');
      await deps.audit.record(
        {
          actorType: 'ADMIN',
          actorId,
          action: 'queue.job_retried',
          resourceType: 'queueJob',
          resourceId: `${queue}:${jobId}`,
          details: { reason },
        },
        ctx,
      );
      return { retried: true };
    },
  };
}

export type SystemService = ReturnType<typeof createSystemService>;
