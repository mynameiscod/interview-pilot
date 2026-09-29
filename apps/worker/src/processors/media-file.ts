import { spawn } from 'node:child_process';
import { appendFile, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Logger } from '@cbi/config';
import {
  claimMediaFileBuild,
  completeMediaFileBuild,
  hasUnavailableMediaFiles,
  mediaFileKey,
  mediaParts,
  requeueUnavailableMediaFiles,
  type MediaAssetRecord,
  type MediaFileOutcome,
} from '@cbi/db';
import type { StorageProvider } from '@cbi/provider-adapters';
import type { MediaMime } from '@cbi/shared-types';

/**
 * Joins a finalized recording's parts into one seekable file. Each
 * MediaRecorder instance (a reload, the camera re-acquired, recording
 * toggled) produced its own container, so the stored segments are
 * reassembled per part and ffmpeg concatenates the parts: stream copy first
 * (fast, lossless), a re-encode when the parts do not line up (a different
 * camera resolution or codec). MP4 gets `+faststart` (index up front); the
 * WebM muxer writes duration and cues, which is what makes it seekable.
 *
 * ffmpeg is a system binary (installed in the worker image). Without it the
 * file is marked UNAVAILABLE and the recording keeps playing part by part;
 * once ffmpeg answers again (see createUnavailableRetry) those files are
 * queued and built. The joined file is uploaded from disk as a stream.
 */

/** ffmpeg could not be started (not installed, or not on the path). */
export class FfmpegMissingError extends Error {
  constructor(cause: unknown) {
    super('ffmpeg is not available', { cause });
    this.name = 'FfmpegMissingError';
  }
}

/** Runs ffmpeg with `args` in `cwd`; rejects with the end of its stderr on failure. */
export type FfmpegRunner = (args: string[], cwd: string) => Promise<void>;

export function createFfmpegRunner(opts: { path?: string; timeoutMs?: number } = {}): FfmpegRunner {
  const bin = opts.path ?? 'ffmpeg';
  const timeoutMs = opts.timeoutMs ?? 20 * 60_000;
  return (args, cwd) =>
    new Promise<void>((resolve, reject) => {
      let stderr = '';
      let child;
      try {
        child = spawn(bin, args, { cwd, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
      } catch (err) {
        reject(new FfmpegMissingError(err));
        return;
      }
      const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
      child.stderr.on('data', (chunk: Buffer) => {
        // Keep only the end: that is where ffmpeg says what went wrong.
        stderr = (stderr + chunk.toString()).slice(-2000);
      });
      child.once('error', (err: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        reject(err.code === 'ENOENT' || err.code === 'EACCES' ? new FfmpegMissingError(err) : err);
      });
      child.once('close', (code, signal) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(`ffmpeg exited with ${signal ?? code}: ${stderr.trim()}`));
      });
    });
}

const EXT: Record<MediaMime, string> = { 'video/webm': 'webm', 'video/mp4': 'mp4' };

/** The ffmpeg arguments that join the parts listed in `list` into `out`. */
export function joinArgs(list: string, out: string, mime: MediaMime, mode: 'copy' | 'encode') {
  const codecs =
    mode === 'copy'
      ? ['-c', 'copy']
      : mime === 'video/mp4'
        ? ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-c:a', 'aac']
        : ['-c:v', 'libvpx', '-deadline', 'realtime', '-cpu-used', '8', '-b:v', '1M'].concat([
            '-c:a',
            'libopus',
          ]);
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    // MediaRecorder timestamps restart in every part; concat rebases them, genpts fills gaps.
    '-fflags',
    '+genpts',
    '-f',
    'concat',
    '-safe',
    '0',
    '-i',
    list,
    ...codecs,
    ...(mime === 'video/mp4' ? ['-movflags', '+faststart'] : []),
    out,
  ];
}

export interface MediaFileDeps {
  storage: Pick<StorageProvider, 'get' | 'putFile'>;
  ffmpeg: FfmpegRunner;
  logger: Logger;
  /** Where temporary part files go (the OS temp directory by default). */
  tmpRoot?: string;
}

/** Builds and stores one recording's joined file. Never throws: the outcome says what happened. */
export async function buildMediaFile(
  asset: MediaAssetRecord,
  deps: MediaFileDeps,
): Promise<MediaFileOutcome> {
  const parts = mediaParts(asset);
  if (parts.length === 0) return { status: 'FAILED', error: 'no playable part' };
  const ext = EXT[asset.mimeType];
  const dir = await mkdtemp(join(deps.tmpRoot ?? tmpdir(), 'cbi-media-'));
  try {
    const names: string[] = [];
    for (const part of parts) {
      // A part's segments in index order are one container (gaps are skipped by the demuxer).
      // Appended one by one: only a segment (≤ 8 MB) is held in memory at a time.
      const name = `part-${part.part}.${ext}`;
      await writeFile(join(dir, name), Buffer.alloc(0));
      for (const seg of part.segments) {
        await appendFile(join(dir, name), await deps.storage.get(seg.storageKey));
      }
      names.push(name);
    }
    await writeFile(join(dir, 'parts.txt'), names.map((n) => `file '${n}'\n`).join(''));
    const out = `recording.${ext}`;
    try {
      await deps.ffmpeg(joinArgs('parts.txt', out, asset.mimeType, 'copy'), dir);
    } catch (err) {
      if (err instanceof FfmpegMissingError) throw err;
      deps.logger.info(
        { err, assetId: String(asset._id), parts: parts.length },
        'recording parts do not join as they are; re-encoding',
      );
      await deps.ffmpeg(joinArgs('parts.txt', out, asset.mimeType, 'encode'), dir);
    }
    // Streamed from disk: a long recording is never held in memory whole.
    const { size } = await stat(join(dir, out));
    if (size === 0) return { status: 'FAILED', error: 'ffmpeg wrote an empty file' };
    const key = mediaFileKey(asset);
    await deps.storage.putFile(key, join(dir, out), asset.mimeType);
    return { status: 'READY', key, bytes: size };
  } catch (err) {
    if (err instanceof FfmpegMissingError) return { status: 'UNAVAILABLE', error: err.message };
    return { status: 'FAILED', error: err instanceof Error ? err.message : String(err) };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export interface MediaFileRunResult {
  built: number;
  failed: number;
  unavailable: number;
  /** Files marked UNAVAILABLE queued again because ffmpeg answers now. */
  requeued: number;
}

/** Checks for ffmpeg and requeues UNAVAILABLE files when it answers; returns how many. */
export type UnavailableRetry = (now: Date) => Promise<number>;

/** How often ffmpeg is looked for while files wait for it. */
export const FFMPEG_PROBE_INTERVAL_MS = 10 * 60_000;

/**
 * Files marked UNAVAILABLE (the worker had no ffmpeg) are never claimed
 * again on their own. While any wait, this runs `ffmpeg -version` at most
 * every `intervalMs`; when it succeeds (installed since, or MEDIA_FFMPEG_PATH
 * fixed) they are queued to be built like new ones.
 */
export function createUnavailableRetry(opts: {
  ffmpeg: FfmpegRunner;
  logger: Logger;
  intervalMs?: number;
}): UnavailableRetry {
  const intervalMs = opts.intervalMs ?? FFMPEG_PROBE_INTERVAL_MS;
  let lastProbe = -Infinity;
  return async (now) => {
    if (now.getTime() - lastProbe < intervalMs) return 0;
    if (!(await hasUnavailableMediaFiles())) return 0;
    lastProbe = now.getTime();
    try {
      await opts.ffmpeg(['-hide_banner', '-version'], tmpdir());
    } catch (err) {
      if (err instanceof FfmpegMissingError) return 0;
      opts.logger.warn({ err }, 'ffmpeg check failed');
      return 0;
    }
    const requeued = await requeueUnavailableMediaFiles(now);
    if (requeued > 0) opts.logger.info({ requeued }, 'ffmpeg is available: recording files queued');
    return requeued;
  };
}

/**
 * Builds the joined files that are waiting, one at a time, up to `max` per
 * run. Claims are atomic, so several worker replicas share the work. When
 * ffmpeg is missing the run stops after the first attempt (one recording is
 * marked UNAVAILABLE per run instead of churning through all of them).
 */
export async function runMediaFileBuilds(
  deps: MediaFileDeps & { max?: number; now?: () => Date; retryUnavailable?: UnavailableRetry },
): Promise<MediaFileRunResult> {
  const now = deps.now ?? (() => new Date());
  const result: MediaFileRunResult = { built: 0, failed: 0, unavailable: 0, requeued: 0 };
  if (deps.retryUnavailable) result.requeued = await deps.retryUnavailable(now());
  for (let i = 0; i < (deps.max ?? 5); i++) {
    const claimed = await claimMediaFileBuild(now());
    if (!claimed) break;
    const outcome = await buildMediaFile(claimed, deps);
    const recorded = await completeMediaFileBuild(claimed, outcome, now());
    const assetId = String(claimed._id);
    if (outcome.status === 'READY') result.built++;
    else if (outcome.status === 'UNAVAILABLE') result.unavailable++;
    else result.failed++;
    if (!recorded) {
      // Re-finalized (a late segment: it is built again) or deleted (the sweep removes the file).
      deps.logger.info({ assetId }, 'recording changed while its file was built');
    } else if (outcome.status !== 'READY') {
      deps.logger.warn(
        { assetId, status: outcome.status, error: outcome.error },
        'recording file not built; it plays part by part',
      );
    }
    if (outcome.status === 'UNAVAILABLE') break;
  }
  if (result.built + result.failed > 0) deps.logger.info(result, 'recording files built');
  return result;
}
