import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from 'prom-client';

/**
 * Prometheus metrics for the API and the worker, served on `/metrics` inside the
 * Docker network only (NGINX answers 404 for it publicly; METRICS_TOKEN adds a
 * bearer token). Labels are bounded sets only: route patterns, queue and job
 * names, provider keys and AI features — never ids, users or URLs.
 * Alert rules: docs/deployment/observability.md.
 */
export const metricsRegistry = new Registry();
const registers = [metricsRegistry];

export const httpRequestDuration = new Histogram({
  name: 'cbi_http_request_duration_seconds',
  help: 'HTTP request latency by method, route pattern and status code',
  labelNames: ['method', 'route', 'status_code'] as const,
  buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
  registers,
});

export const socketConnections = new Gauge({
  name: 'cbi_socketio_connections',
  help: 'Open Socket.IO connections on this API process',
  registers,
});

export interface QueueDepth {
  name: string;
  waiting: number;
  active: number;
  delayed: number;
  failed: number;
  completed?: number;
  paused?: boolean;
}

let queueDepthSource: (() => Promise<QueueDepth[]>) | null = null;

/** Where the queue gauge reads its counts from at scrape time (the worker sets it). */
export function setQueueDepthSource(source: (() => Promise<QueueDepth[]>) | null): void {
  queueDepthSource = source;
}

export const queueJobs = new Gauge({
  name: 'cbi_queue_jobs',
  help: 'BullMQ jobs per queue and state, read at scrape time',
  labelNames: ['queue', 'state'] as const,
  registers,
  async collect() {
    if (!queueDepthSource) return;
    let depths: QueueDepth[];
    try {
      depths = await queueDepthSource();
    } catch {
      // Redis unavailable: keep the last values; the readiness probe reports the outage.
      return;
    }
    this.reset();
    for (const q of depths) {
      for (const state of ['waiting', 'active', 'delayed', 'failed'] as const) {
        this.set({ queue: q.name, state }, q[state]);
      }
      this.set({ queue: q.name, state: 'paused' }, q.paused ? 1 : 0);
    }
  },
});

export const queueJobsFailedTotal = new Counter({
  name: 'cbi_queue_jobs_failed_total',
  help: 'BullMQ job attempts that failed, by queue and job name',
  labelNames: ['queue', 'job_name'] as const,
  registers,
});

export const queueJobsCompletedTotal = new Counter({
  name: 'cbi_queue_jobs_completed_total',
  help: 'BullMQ jobs completed, by queue and job name',
  labelNames: ['queue', 'job_name'] as const,
  registers,
});

export const workerHeartbeatTimestamp = new Gauge({
  name: 'cbi_worker_heartbeat_timestamp_seconds',
  help: 'Unix time of the last heartbeat job this worker processed',
  registers,
});

export const aiCallDuration = new Histogram({
  name: 'cbi_ai_call_duration_seconds',
  help: 'AI provider call latency by provider, feature and outcome',
  labelNames: ['provider', 'feature', 'outcome'] as const,
  buckets: [0.25, 0.5, 1, 2, 4, 8, 15, 30, 60, 120],
  registers,
});

export const aiCallErrorsTotal = new Counter({
  name: 'cbi_ai_call_errors_total',
  help: 'AI provider calls that did not succeed, by provider, feature and outcome',
  labelNames: ['provider', 'feature', 'outcome'] as const,
  registers,
});

export const judgeFailuresTotal = new Counter({
  name: 'cbi_judge_failures_total',
  help: 'Code judge calls that failed (judge unavailable), by provider and caller',
  labelNames: ['provider', 'source'] as const,
  registers,
});

/**
 * Realtime voice turn latency by stage (see VoiceLatencyStage in shared-types):
 * end of speech → first question token / first audio byte, and the same
 * from the answer's submission. Target: p50 below 2.5 s for speech → audio.
 */
export const voiceTurnLatency = new Histogram({
  name: 'cbi_voice_turn_latency_seconds',
  help: 'Realtime voice turn latency by stage',
  labelNames: ['stage'] as const,
  buckets: [0.25, 0.5, 0.75, 1, 1.5, 2, 2.5, 3, 4, 6, 10],
  registers,
});

export const voiceStreamsOpen = new Gauge({
  name: 'cbi_voice_stt_streams',
  help: 'Streaming speech-to-text sessions open on this API process',
  registers,
});

export const voiceStreamEventsTotal = new Counter({
  name: 'cbi_voice_stream_events_total',
  help: 'Realtime voice events: opened, turn_end, resumed, fallback, rate_limited, barge_in',
  labelNames: ['event'] as const,
  registers,
});

export function observeVoiceLatency(stage: string, ms: number): void {
  if (Number.isFinite(ms) && ms >= 0) voiceTurnLatency.observe({ stage }, ms / 1000);
}

/** The fields of an AI usage record the metrics need (ai-core's AiUsageRecord satisfies it). */
export interface AiCallObservation {
  providerKey: string;
  feature: string;
  outcome: string;
  latencyMs: number;
}

/** Hook for the AI router's usage sink: one call per provider attempt. */
export function observeAiCall(call: AiCallObservation): void {
  const labels = { provider: call.providerKey, feature: call.feature, outcome: call.outcome };
  aiCallDuration.observe(labels, Math.max(0, call.latencyMs) / 1000);
  if (call.outcome !== 'SUCCESS') aiCallErrorsTotal.inc(labels);
}

/** Counts a judge outage seen by `source` (code-run, code-submit, evaluation). */
export function recordJudgeFailure(err: unknown, source: string): void {
  const provider = (err as { provider?: unknown } | null)?.provider;
  judgeFailuresTotal.inc({ provider: typeof provider === 'string' ? provider : 'unknown', source });
}

let initialized = false;

/** Adds the `service` label and Node process metrics (CPU, memory, event-loop lag). */
export function initMetrics(opts: { service: string }): void {
  if (initialized) return;
  initialized = true;
  metricsRegistry.setDefaultLabels({ service: opts.service });
  collectDefaultMetrics({ register: metricsRegistry, prefix: 'cbi_' });
}

const digest = (value: string) => createHash('sha256').update(value).digest();

/** True when no token is configured, or the request carries `Authorization: Bearer <token>`. */
export function metricsAuthorized(authorization: string | undefined, token?: string): boolean {
  if (!token) return true;
  const match = /^Bearer\s+(.+)$/i.exec(authorization ?? '');
  // Hashing first gives equal-length buffers, so the comparison is constant-time.
  return match ? timingSafeEqual(digest(match[1]!.trim()), digest(token)) : false;
}

/** A plain Node request handler for `GET /metrics` (used by Express and the worker health server). */
export function metricsHandler(opts: { token?: string }) {
  return (req: IncomingMessage, res: ServerResponse): void => {
    if (!metricsAuthorized(req.headers.authorization, opts.token)) {
      res.writeHead(401, {
        'Content-Type': 'text/plain',
        'Cache-Control': 'no-store',
        'WWW-Authenticate': 'Bearer',
      });
      res.end('unauthorized\n');
      return;
    }
    metricsRegistry.metrics().then(
      (body) => {
        res.writeHead(200, {
          'Content-Type': metricsRegistry.contentType,
          'Cache-Control': 'no-store',
        });
        res.end(body);
      },
      () => {
        res.writeHead(500, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
        res.end('metrics unavailable\n');
      },
    );
  };
}
