import { MEDIA_LIMITS, type FinalizeMediaBody } from '@cbi/shared-types';
import type { RecordingMeta, SegmentStore, StoredSegment } from './segment-store';

/** An HTTP answer, reduced to what the queue decides on. */
export interface SendResult {
  status: number;
  /** The API error code, when there was one. */
  code?: string | null;
}

/** Uploads one segment. Throws on a network error (retried). */
export type SegmentSender = (idx: number, blob: Blob, contentType: string) => Promise<SendResult>;
/** Tells the server the recording ended. Throws on a network error (retried). */
export type RecordingFinalizer = (body: FinalizeMediaBody) => Promise<SendResult>;

export interface UploadQueueDeps {
  store: SegmentStore;
  send: SegmentSender;
  finalize: RecordingFinalizer;
  /** Jitter source (tests pin it). */
  random?: () => number;
  /** Dropped segments and closed uploads are logged here. */
  log?: (message: string, details: Record<string, unknown>) => void;
}

export interface UploadStatus {
  /** Segments recorded but not yet stored by the server. */
  waiting: number;
  /** A retry is scheduled after a failure. */
  retrying: boolean;
  /** Recording ended and the server was told (or will never accept more). */
  done: boolean;
  /** The server stopped accepting segments (not recorded, uploads closed, deleted). */
  closed: boolean;
}

export const UPLOAD_BACKOFF = { baseMs: 1_000, maxMs: 60_000 } as const;

/** 1 s, 2 s, 4 s … capped at 60 s, with ±20 % jitter so tabs do not retry in step. */
export function retryDelay(attempt: number, random: () => number = Math.random): number {
  const exp = Math.min(UPLOAD_BACKOFF.maxMs, UPLOAD_BACKOFF.baseMs * 2 ** Math.max(0, attempt));
  return Math.min(UPLOAD_BACKOFF.maxMs, Math.round(exp * (0.8 + random() * 0.4)));
}

export type UploadOutcome = 'done' | 'drop' | 'retry' | 'stop';

/**
 * - done: stored (201) or already stored (200 duplicate)
 * - retry: network, 5xx, 429, 408, or 401 after the sender's own refresh
 * - drop: this segment can never be stored (index conflict, 415 format, 413 size, 400)
 * - stop: the server takes no more segments (409 "not being recorded"/"uploads closed", 404)
 */
export function classifyUpload(result: SendResult): UploadOutcome {
  const { status, code } = result;
  if (status === 200 || status === 201) return 'done';
  if (status === 401 || status === 408 || status === 429 || status >= 500) return 'retry';
  if (status === 409) return code === 'CONFLICT' ? 'drop' : 'stop';
  if (status === 403 || status === 404) return 'stop';
  return 'drop';
}

/** Dropped segments and closed uploads are diagnostics for support, not UI. */
function defaultLog(message: string, details: Record<string, unknown>) {
  // eslint-disable-next-line no-console
  console.warn(message, details);
}

/**
 * The upload queue for one interview's recording. Segments are persisted
 * before they are sent, uploaded one at a time in index order, retried with
 * backoff, and forgotten once the server has them. When the recording ends
 * and nothing is left, the server is told how many segments there were.
 *
 * Nothing here ever throws into the interview: uploads run in the
 * background and only report a status.
 */
export class SegmentUploadQueue {
  private readonly pending = new Map<number, StoredSegment>();
  private meta: RecordingMeta;
  private readonly loaded: Promise<void>;
  private running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  private closed = false;
  private finalized = false;
  private disposed = false;
  private stopping: Promise<unknown> = Promise.resolve();
  private readonly listeners = new Set<() => void>();
  private status: UploadStatus = { waiting: 0, retrying: false, done: false, closed: false };

  constructor(
    readonly sessionId: string,
    private readonly deps: UploadQueueDeps,
  ) {
    this.meta = { sessionId, nextIdx: 0, durationMs: 0, ended: false };
    this.loaded = this.load();
  }

  private log(message: string, details: Record<string, unknown> = {}) {
    (this.deps.log ?? defaultLog)(message, { sessionId: this.sessionId, ...details });
  }

  private async load() {
    try {
      const [meta, stored] = await Promise.all([
        this.deps.store.getMeta(this.sessionId),
        this.deps.store.segments(this.sessionId),
      ]);
      if (meta) {
        this.meta = {
          ...meta,
          nextIdx: Math.max(meta.nextIdx, this.meta.nextIdx),
          durationMs: Math.max(meta.durationMs, this.meta.durationMs),
          ended: meta.ended || this.meta.ended,
        };
      }
      for (const segment of stored) {
        if (!this.pending.has(segment.idx)) this.pending.set(segment.idx, segment);
        this.meta.nextIdx = Math.max(this.meta.nextIdx, segment.idx + 1);
      }
    } catch {
      // Nothing persisted can be read: carry on with what this page records.
    }
    this.emit();
    void this.pump();
  }

  /** Resolves once anything persisted by an earlier page load has been restored. */
  async ready(): Promise<{ nextIdx: number; ended: boolean; closed: boolean }> {
    await this.loaded;
    return { nextIdx: this.meta.nextIdx, ended: this.meta.ended, closed: this.closed };
  }

  /** The recording can (still) record: not ended, not closed by the server. */
  get accepting(): boolean {
    return !this.meta.ended && !this.closed && !this.disposed;
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };

  getStatus = (): UploadStatus => this.status;

  private emit() {
    const next: UploadStatus = {
      waiting: this.pending.size,
      retrying: this.timer !== null,
      done: this.finalized || this.closed,
      closed: this.closed,
    };
    const prev = this.status;
    if (
      prev.waiting === next.waiting &&
      prev.retrying === next.retrying &&
      prev.done === next.done &&
      prev.closed === next.closed
    ) {
      return;
    }
    this.status = next;
    for (const listener of [...this.listeners]) listener();
  }

  private persistMeta() {
    void this.deps.store.putMeta({ ...this.meta }).catch(() => undefined);
  }

  /**
   * Adds a recorded chunk as the next segment and starts uploading it.
   * Returns its index (-1 when the recording no longer takes segments).
   */
  add(blob: Blob, contentType: string, durationMs: number): number {
    if (this.closed || this.disposed || this.meta.nextIdx >= MEDIA_LIMITS.maxSegments) return -1;
    const idx = this.meta.nextIdx;
    this.meta.nextIdx += 1;
    this.meta.durationMs += Math.max(0, durationMs);
    const segment: StoredSegment = { sessionId: this.sessionId, idx, blob, contentType };
    this.pending.set(idx, segment);
    void this.deps.store.putSegment(segment).catch(() => undefined);
    this.persistMeta();
    this.emit();
    void this.pump();
    return idx;
  }

  /** The recorder is stopping; `finish` waits for its last chunk. */
  trackStop(stopped: Promise<unknown>) {
    this.stopping = Promise.all([this.stopping, stopped.catch(() => undefined)]);
  }

  /**
   * The recording ended (interview over, or switched away from video). Once
   * every segment is uploaded, the server is told the count and duration.
   * Does nothing when this interview never recorded here.
   */
  async finish(): Promise<void> {
    await this.loaded;
    await this.stopping;
    if (this.disposed || this.closed || this.finalized) return;
    if (this.meta.nextIdx === 0 && !this.meta.ended) return;
    if (!this.meta.ended) {
      this.meta.ended = true;
      this.persistMeta();
    }
    void this.pump();
  }

  /** Retry now (the browser came back online). */
  retryNow() {
    if (this.timer === null) return;
    clearTimeout(this.timer);
    this.timer = null;
    this.emit();
    void this.pump();
  }

  /** Stops all work (tests; the queue otherwise lives as long as the page). */
  dispose() {
    this.disposed = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.listeners.clear();
  }

  private schedule() {
    const delay = retryDelay(this.attempt, this.deps.random);
    this.attempt += 1;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.emit();
      void this.pump();
    }, delay);
    this.emit();
  }

  private async close(reason: string, details: Record<string, unknown>) {
    this.closed = true;
    this.log(`recording uploads stopped: ${reason}`, details);
    this.pending.clear();
    this.emit();
    await this.deps.store.clear(this.sessionId).catch(() => undefined);
  }

  private async pump(): Promise<void> {
    if (this.running || this.timer !== null || this.closed || this.disposed || this.finalized) {
      return;
    }
    this.running = true;
    try {
      while (this.pending.size > 0 && !this.closed && !this.disposed) {
        const idx = Math.min(...this.pending.keys());
        const segment = this.pending.get(idx)!;
        let result: SendResult | null;
        try {
          result = await this.deps.send(idx, segment.blob, segment.contentType);
        } catch {
          result = null; // Offline or the connection dropped.
        }
        if (this.disposed) return;
        const outcome = result ? classifyUpload(result) : 'retry';
        if (outcome === 'retry') {
          this.schedule();
          return;
        }
        this.attempt = 0;
        if (outcome === 'stop') {
          await this.close('the server takes no more segments', { idx, ...result });
          return;
        }
        if (outcome === 'drop') this.log('recording segment dropped', { idx, ...result });
        this.pending.delete(idx);
        await this.deps.store.deleteSegment(this.sessionId, idx).catch(() => undefined);
        this.emit();
      }
      if (this.meta.ended && this.pending.size === 0 && !this.closed && !this.disposed) {
        await this.sendFinalize();
      }
    } finally {
      this.running = false;
    }
  }

  private async sendFinalize() {
    let result: SendResult | null;
    try {
      result = await this.deps.finalize({
        segmentCount: Math.min(this.meta.nextIdx, MEDIA_LIMITS.maxSegments),
        durationMs: Math.min(Math.round(this.meta.durationMs), 6 * 3600_000),
      });
    } catch {
      result = null;
    }
    if (this.disposed) return;
    const outcome = result ? classifyUpload(result) : 'retry';
    if (outcome === 'retry') {
      this.schedule();
      return;
    }
    this.attempt = 0;
    if (outcome !== 'done') this.log('recording finalize refused', { ...result });
    this.finalized = true;
    await this.deps.store.clear(this.sessionId).catch(() => undefined);
    this.emit();
  }
}

const queues = new Map<string, SegmentUploadQueue>();

/** One queue per interview for the life of the page (it keeps uploading after the room closes). */
export function getUploadQueue(sessionId: string, deps: () => UploadQueueDeps): SegmentUploadQueue {
  let queue = queues.get(sessionId);
  if (!queue) {
    queue = new SegmentUploadQueue(sessionId, deps());
    queues.set(sessionId, queue);
  }
  return queue;
}

/** Tests: stop and forget every queue. */
export function resetUploadQueues() {
  for (const queue of queues.values()) queue.dispose();
  queues.clear();
}
