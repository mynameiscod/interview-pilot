import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  aiCallErrorsTotal,
  metricsAuthorized,
  metricsHandler,
  metricsRegistry,
  observeAiCall,
  queueJobs,
  recordJudgeFailure,
  setQueueDepthSource,
} from './metrics.js';

const valueOf = async (
  metric: { get(): Promise<{ values: { labels: object; value: number }[] }> },
  labels: object,
) =>
  (await metric.get()).values.find((v) => JSON.stringify(v.labels) === JSON.stringify(labels))
    ?.value;

describe('metricsAuthorized', () => {
  it('allows everything when no token is configured', () => {
    expect(metricsAuthorized(undefined, undefined)).toBe(true);
  });

  it('requires the exact bearer token when one is configured', () => {
    const token = 'metrics-token-0123456789';
    expect(metricsAuthorized(`Bearer ${token}`, token)).toBe(true);
    expect(metricsAuthorized('Bearer wrong', token)).toBe(false);
    expect(metricsAuthorized(token, token)).toBe(false);
    expect(metricsAuthorized(undefined, token)).toBe(false);
  });
});

describe('observeAiCall', () => {
  it('records latency for every call and counts failures', async () => {
    observeAiCall({
      providerKey: 'openai',
      feature: 'turn.next',
      outcome: 'SUCCESS',
      latencyMs: 800,
    });
    observeAiCall({
      providerKey: 'openai',
      feature: 'turn.next',
      outcome: 'TIMEOUT',
      latencyMs: 30000,
    });
    const text = await metricsRegistry.getSingleMetricAsString('cbi_ai_call_duration_seconds');
    expect(text).toContain(
      'cbi_ai_call_duration_seconds_count{provider="openai",feature="turn.next",outcome="SUCCESS"} 1',
    );
    expect(
      await valueOf(aiCallErrorsTotal, {
        provider: 'openai',
        feature: 'turn.next',
        outcome: 'TIMEOUT',
      }),
    ).toBe(1);
    expect(
      await valueOf(aiCallErrorsTotal, {
        provider: 'openai',
        feature: 'turn.next',
        outcome: 'SUCCESS',
      }),
    ).toBeUndefined();
  });
});

describe('recordJudgeFailure', () => {
  it('labels by the error provider and the caller', async () => {
    recordJudgeFailure({ provider: 'judge0' }, 'code-run');
    recordJudgeFailure(new Error('x'), 'evaluation');
    const text = await metricsRegistry.getSingleMetricAsString('cbi_judge_failures_total');
    expect(text).toContain('cbi_judge_failures_total{provider="judge0",source="code-run"} 1');
    expect(text).toContain('cbi_judge_failures_total{provider="unknown",source="evaluation"} 1');
  });
});

describe('queue depth gauge', () => {
  it('reads counts at scrape time and keeps old values when the source fails', async () => {
    setQueueDepthSource(async () => [
      { name: 'evaluation', waiting: 4, active: 1, delayed: 0, failed: 2, paused: false },
    ]);
    expect(await valueOf(queueJobs, { queue: 'evaluation', state: 'waiting' })).toBe(4);
    expect(await valueOf(queueJobs, { queue: 'evaluation', state: 'failed' })).toBe(2);
    setQueueDepthSource(() => Promise.reject(new Error('redis down')));
    expect(await valueOf(queueJobs, { queue: 'evaluation', state: 'waiting' })).toBe(4);
    setQueueDepthSource(null);
  });
});

describe('metricsHandler', () => {
  let server: Server;
  let url: string;
  beforeAll(async () => {
    server = createServer(metricsHandler({ token: 'metrics-token-0123456789' }));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/metrics`;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it('answers 401 without the token', async () => {
    const res = await fetch(url);
    expect(res.status).toBe(401);
  });

  it('serves the Prometheus text format with the token', async () => {
    const res = await fetch(url, { headers: { Authorization: 'Bearer metrics-token-0123456789' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
    expect(await res.text()).toContain('# TYPE cbi_http_request_duration_seconds histogram');
  });
});
