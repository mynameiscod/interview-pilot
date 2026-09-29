import type { AddressInfo } from 'node:net';
import { createLogger, metricsHandler, metricsRegistry } from '@cbi/config';
import { describe, expect, it, vi } from 'vitest';
import { createHealthServer } from './health-server.js';
import { reportJobFailure } from './worker.js';

const logger = createLogger({ service: 'worker-test', level: 'silent' });
const tracker = () => ({ enabled: true, captureException: vi.fn(), flush: vi.fn() });
const job = (attemptsMade: number, attempts?: number) => ({
  id: '17',
  name: 'evaluation.stage',
  attemptsMade,
  opts: attempts === undefined ? {} : { attempts },
});

describe('reportJobFailure', () => {
  it('counts every failed attempt but reports only the one that exhausts retries', async () => {
    const t = tracker();
    const err = new Error('scoring failed');
    reportJobFailure({ logger, errorTracker: t }, 'evaluation', job(1, 3), err);
    reportJobFailure({ logger, errorTracker: t }, 'evaluation', job(2, 3), err);
    expect(t.captureException).not.toHaveBeenCalled();
    reportJobFailure({ logger, errorTracker: t }, 'evaluation', job(3, 3), err);
    expect(t.captureException).toHaveBeenCalledWith(err, {
      tags: { queue: 'evaluation', job_name: 'evaluation.stage' },
      extra: { jobId: '17', attemptsMade: 3 },
    });
    const text = await metricsRegistry.getSingleMetricAsString('cbi_queue_jobs_failed_total');
    expect(text).toContain(
      'cbi_queue_jobs_failed_total{queue="evaluation",job_name="evaluation.stage"} 3',
    );
  });

  it('reports jobs without retries and failures without a job', () => {
    const t = tracker();
    reportJobFailure({ logger, errorTracker: t }, 'system', job(1), new Error('x'));
    reportJobFailure({ logger, errorTracker: t }, 'system', undefined, new Error('y'));
    expect(t.captureException).toHaveBeenCalledTimes(2);
  });
});

describe('health server /metrics', () => {
  it('serves metrics only when a handler is configured', async () => {
    const probes = { redis: async () => undefined };
    const withMetrics = createHealthServer({
      env: 'test',
      version: '1',
      probes,
      isDraining: () => false,
      metrics: metricsHandler({}),
    });
    const without = createHealthServer({
      env: 'test',
      version: '1',
      probes,
      isDraining: () => false,
    });
    const urlOf = async (server: typeof without) => {
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      return `http://127.0.0.1:${(server.address() as AddressInfo).port}/metrics`;
    };
    try {
      const res = await fetch(await urlOf(withMetrics));
      expect(res.status).toBe(200);
      expect(await res.text()).toContain('cbi_queue_jobs_failed_total');
      expect((await fetch(await urlOf(without))).status).toBe(404);
    } finally {
      withMetrics.close();
      without.close();
    }
  });
});
