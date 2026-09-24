import type { Logger } from '@cbi/config';
import { applySessionEvent, InterviewSessionModel, type InterviewSessionRecord } from '@cbi/db';
import type { SessionEvent } from '@cbi/interview-engine';
import { LIVE_POLICY } from '@cbi/shared-types';

export interface LiveSweepOptions {
  now?: Date;
  logger: Logger;
  heartbeatTimeoutMs?: number;
  reconnectGraceMs?: number;
  resumeWindowMs?: number;
  /** COMPLETING longer than this means the finishing API instance died. */
  completingTimeoutMs?: number;
  batchSize?: number;
}

export interface LiveSweepResult {
  disconnected: number;
  paused: number;
  expired: number;
  finalized: number;
}

type Candidate = Pick<InterviewSessionRecord, '_id' | 'stateVersion'>;

/**
 * Time-based session transitions that no client event triggers (design §6.1):
 * a silent live room becomes RECONNECTING, RECONNECTING becomes PAUSED after
 * the grace period, PAUSED becomes EXPIRED after the resume window (settling
 * the credit), and a stuck COMPLETING is finished. Each transition is
 * conditional on the session's version, so racing an API instance is safe.
 */
export async function sweepLiveSessions(opts: LiveSweepOptions): Promise<LiveSweepResult> {
  const now = opts.now ?? new Date();
  const limit = opts.batchSize ?? 200;
  const ago = (ms: number) => new Date(now.getTime() - ms);
  const result: LiveSweepResult = { disconnected: 0, paused: 0, expired: 0, finalized: 0 };

  async function apply(rows: Candidate[], event: SessionEvent, reason: string) {
    let applied = 0;
    for (const row of rows) {
      const r = await applySessionEvent({
        sessionId: row._id,
        event,
        expectedVersion: row.stateVersion,
        reason,
        now,
      }).catch((err: unknown) => {
        opts.logger.error(
          { err, sessionId: String(row._id), event: event.type },
          'sweep transition failed',
        );
        return null;
      });
      if (r?.ok) {
        applied++;
        if (event.type === 'RESUME_WINDOW_EXPIRED') {
          // A meaningful partial interview still gets evaluated; otherwise it stays EXPIRED.
          await applySessionEvent({ sessionId: row._id, event: { type: 'PROCESS' }, now }).catch(
            () => null,
          );
        }
      }
    }
    return applied;
  }

  const find = (filter: Record<string, unknown>) =>
    InterviewSessionModel.find(filter, { _id: 1, stateVersion: 1 })
      .limit(limit)
      .lean<Candidate[]>();

  result.disconnected = await apply(
    await find({
      state: { $in: ['ACTIVE', 'ROUND_TRANSITION'] },
      lastSeenAt: { $lt: ago(opts.heartbeatTimeoutMs ?? LIVE_POLICY.heartbeatTimeoutMs) },
    }),
    { type: 'DISCONNECTED' },
    'no heartbeat',
  );
  result.paused = await apply(
    await find({
      state: 'RECONNECTING',
      disconnectedAt: { $lt: ago(opts.reconnectGraceMs ?? LIVE_POLICY.reconnectGraceMs) },
    }),
    { type: 'GRACE_EXPIRED' },
    'reconnect grace expired',
  );
  result.expired = await apply(
    await find({
      state: 'PAUSED',
      pausedAt: { $lt: ago(opts.resumeWindowMs ?? LIVE_POLICY.resumeWindowMs) },
    }),
    { type: 'RESUME_WINDOW_EXPIRED' },
    'resume window expired',
  );
  result.finalized = await apply(
    await find({
      state: 'COMPLETING',
      updatedAt: { $lt: ago(opts.completingTimeoutMs ?? 2 * 60_000) },
    }),
    { type: 'FINALIZE' },
    'finished by sweep',
  );
  return result;
}
