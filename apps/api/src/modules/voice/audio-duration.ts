import { VOICE_LIMITS } from '@cbi/shared-types';

/**
 * Server-side length of a recorded answer. Speech usage (and its cost) is
 * billed by duration, and some providers (OpenAI) report none, so the
 * browser's own figure must not be trusted: the container is read instead
 * (WebM/Matroska, Ogg, MP4, WAV). Anything else, or a file the light
 * parsers cannot read, falls back to the client's value bounded by what
 * the byte count allows and by the answer limit.
 */

/** No browser codec records speech below this bitrate (Opus' floor is 6 kbit/s). */
const MIN_BYTES_PER_SEC = 6_000 / 8;

type Mime = 'audio/webm' | 'audio/ogg' | 'audio/mp4' | 'audio/wav' | 'audio/mpeg';

/** Seconds of audio in the container, or null when it cannot be read. */
export function containerDurationSec(bytes: Uint8Array, mime: Mime): number | null {
  try {
    const sec =
      mime === 'audio/webm'
        ? webmDuration(bytes)
        : mime === 'audio/ogg'
          ? oggDuration(bytes)
          : mime === 'audio/mp4'
            ? mp4Duration(bytes)
            : mime === 'audio/wav'
              ? wavDuration(bytes)
              : null;
    return sec !== null && Number.isFinite(sec) && sec >= 0 ? sec : null;
  } catch {
    return null;
  }
}

/**
 * The duration used for usage and cost: the container's when it can be
 * read, otherwise the client's (never more than the bytes could hold), and
 * never above the longest answer allowed.
 */
export function billableDurationSec(bytes: Uint8Array, mime: Mime, clientMs: number): number {
  const max = VOICE_LIMITS.maxAnswerSec;
  const parsed = containerDurationSec(bytes, mime);
  if (parsed !== null) return Math.min(parsed, max);
  return Math.min(Math.max(0, clientMs) / 1000, bytes.length / MIN_BYTES_PER_SEC, max);
}

// ---- WebM / Matroska ---------------------------------------------------------------------

const EBML = {
  SEGMENT: 0x18538067,
  INFO: 0x1549a966,
  TIMECODE_SCALE: 0x2ad7b1,
  DURATION: 0x4489,
  CLUSTER: 0x1f43b675,
  TIMECODE: 0xe7,
  SIMPLE_BLOCK: 0xa3,
  BLOCK_GROUP: 0xa0,
  BLOCK: 0xa1,
  TRACKS: 0x1654ae6b,
} as const;
/** Containers the scan steps into (their children are read in turn). */
const MASTERS = new Set<number>([EBML.SEGMENT, EBML.INFO, EBML.CLUSTER, EBML.BLOCK_GROUP]);

/** An EBML variable-length integer at `pos`: its value (marker kept for ids) and length. */
function vint(b: Uint8Array, pos: number, keepMarker: boolean) {
  const first = b[pos];
  if (first === undefined || first === 0) return null;
  let len = 1;
  while (!(first & (0x80 >> (len - 1)))) len++;
  if (pos + len > b.length) return null;
  let value = keepMarker ? first : first & (0xff >> len);
  let allOnes = value === 0xff >> len;
  for (let i = 1; i < len; i++) {
    value = value * 256 + b[pos + i]!;
    if (b[pos + i] !== 0xff) allOnes = false;
  }
  return { value, len, unknown: !keepMarker && allOnes };
}

function uint(b: Uint8Array, pos: number, size: number) {
  let v = 0;
  for (let i = 0; i < size; i++) v = v * 256 + b[pos + i]!;
  return v;
}

/**
 * MediaRecorder's WebM has no Duration while recording (and live clusters
 * of unknown size), so the last block's timestamp is used when Duration is
 * absent: cluster timecode + the block's relative timecode.
 */
function webmDuration(b: Uint8Array): number | null {
  let pos = 0;
  let scale = 1_000_000; // ns per tick (the default)
  let declared: number | null = null;
  let cluster = 0;
  let last = -1;
  while (pos < b.length) {
    const id = vint(b, pos, true);
    if (!id) break;
    const size = vint(b, pos + id.len, false);
    if (!size) break;
    const data = pos + id.len + size.len;
    if (MASTERS.has(id.value)) {
      pos = data; // step inside (an unknown size simply runs on)
      continue;
    }
    if (size.unknown || data + size.value > b.length) break;
    const view = new DataView(b.buffer, b.byteOffset + data, size.value);
    if (id.value === EBML.TIMECODE_SCALE) scale = uint(b, data, size.value);
    else if (id.value === EBML.DURATION)
      declared = size.value === 4 ? view.getFloat32(0) : view.getFloat64(0);
    else if (id.value === EBML.TIMECODE) cluster = uint(b, data, size.value);
    else if (id.value === EBML.SIMPLE_BLOCK || id.value === EBML.BLOCK) {
      const track = vint(b, data, false);
      if (track) last = Math.max(last, cluster + view.getInt16(track.len));
    }
    pos = data + size.value;
  }
  if (declared !== null && declared > 0) return (declared * scale) / 1e9;
  return last >= 0 ? (last * scale) / 1e9 : null;
}

// ---- Ogg (Opus, Vorbis) -----------------------------------------------------------------

/** The last page's granule position over the sample rate (Opus always counts at 48 kHz). */
function oggDuration(b: Uint8Array): number | null {
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let pos = 0;
  let rate: number | null = null;
  let preSkip = 0;
  let granule = -1;
  while (pos + 27 <= b.length && view.getUint32(pos) === 0x4f676753 /* OggS */) {
    const segments = b[pos + 26]!;
    if (pos + 27 + segments > b.length) break;
    let body = 0;
    for (let i = 0; i < segments; i++) body += b[pos + 27 + i]!;
    const start = pos + 27 + segments;
    if (rate === null && start + 19 <= b.length) {
      const magic = String.fromCharCode(...b.subarray(start, start + 8));
      if (magic === 'OpusHead') {
        rate = 48_000;
        preSkip = view.getUint16(start + 10, true);
      } else if (magic.startsWith('\x01vorbis')) {
        rate = view.getUint32(start + 12, true);
      }
    }
    const g = view.getBigInt64(pos + 6, true);
    if (g >= 0n) granule = Math.max(granule, Number(g));
    pos = start + body;
  }
  if (!rate || granule < 0) return null;
  return Math.max(0, granule - preSkip) / rate;
}

// ---- MP4 (Safari) -------------------------------------------------------------------------

interface Box {
  type: string;
  start: number;
  end: number;
}

function* boxes(b: Uint8Array, from: number, to: number): Generator<Box> {
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let pos = from;
  while (pos + 8 <= to) {
    let size = view.getUint32(pos);
    let header = 8;
    if (size === 1) {
      if (pos + 16 > to) return;
      size = Number(view.getBigUint64(pos + 8));
      header = 16;
    } else if (size === 0) size = to - pos;
    if (size < header || pos + size > to) return;
    yield {
      type: String.fromCharCode(...b.subarray(pos + 4, pos + 8)),
      start: pos + header,
      end: pos + size,
    };
    pos += size;
  }
}

const child = (b: Uint8Array, box: Box, type: string) =>
  [...boxes(b, box.start, box.end)].find((c) => c.type === type) ?? null;

/**
 * `mvhd` duration over its timescale; a fragmented recording (MediaRecorder
 * writes an empty `moov`) sums its fragments instead: the latest
 * `tfdt` base time plus the `trun` sample durations, in the track's timescale.
 */
function mp4Duration(b: Uint8Array): number | null {
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const top = [...boxes(b, 0, b.length)];
  const moov = top.find((x) => x.type === 'moov');
  let trackScale: number | null = null;
  let defaultDuration = 0;
  if (moov) {
    const mvhd = child(b, moov, 'mvhd');
    if (mvhd) {
      const v1 = b[mvhd.start] === 1;
      const timescale = view.getUint32(mvhd.start + (v1 ? 20 : 12));
      const duration = v1
        ? Number(view.getBigUint64(mvhd.start + 24))
        : view.getUint32(mvhd.start + 16);
      if (timescale > 0 && duration > 0 && duration !== 0xffffffff) return duration / timescale;
    }
    const trak = child(b, moov, 'trak');
    const mdia = trak && child(b, trak, 'mdia');
    const mdhd = mdia && child(b, mdia, 'mdhd');
    if (mdhd) trackScale = view.getUint32(mdhd.start + (b[mdhd.start] === 1 ? 20 : 12));
    const mvex = child(b, moov, 'mvex');
    const trex = mvex && child(b, mvex, 'trex');
    if (trex) defaultDuration = view.getUint32(trex.start + 12);
  }
  if (!trackScale) return null;
  let end = 0;
  for (const moof of top.filter((x) => x.type === 'moof')) {
    for (const traf of boxes(b, moof.start, moof.end)) {
      if (traf.type !== 'traf') continue;
      let base = 0;
      let sampleDefault = defaultDuration;
      let total = 0;
      for (const box of boxes(b, traf.start, traf.end)) {
        if (box.type !== 'tfdt' && box.type !== 'tfhd' && box.type !== 'trun') continue;
        const flags = view.getUint32(box.start) & 0xffffff;
        if (box.type === 'tfdt') {
          base =
            b[box.start] === 1
              ? Number(view.getBigUint64(box.start + 4))
              : view.getUint32(box.start + 4);
        } else if (box.type === 'tfhd' && flags & 0x08) {
          // Optional fields before default-sample-duration: base-data-offset, description index.
          const at = box.start + 8 + (flags & 0x01 ? 8 : 0) + (flags & 0x02 ? 4 : 0);
          sampleDefault = view.getUint32(at);
        } else if (box.type === 'trun') {
          const count = view.getUint32(box.start + 4);
          let at = box.start + 8 + (flags & 0x01 ? 4 : 0) + (flags & 0x04 ? 4 : 0);
          const perSample =
            (flags & 0x100 ? 4 : 0) +
            (flags & 0x200 ? 4 : 0) +
            (flags & 0x400 ? 4 : 0) +
            (flags & 0x800 ? 4 : 0);
          for (let i = 0; i < count; i++) {
            total += flags & 0x100 ? view.getUint32(at) : sampleDefault;
            at += perSample;
          }
        }
      }
      end = Math.max(end, base + total);
    }
  }
  return end > 0 ? end / trackScale : null;
}

// ---- WAV ------------------------------------------------------------------------------------

function wavDuration(b: Uint8Array): number | null {
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let byteRate: number | null = null;
  let pos = 12;
  while (pos + 8 <= b.length) {
    const id = String.fromCharCode(...b.subarray(pos, pos + 4));
    const size = view.getUint32(pos + 4, true);
    if (id === 'fmt ' && pos + 16 <= b.length) byteRate = view.getUint32(pos + 16, true);
    if (id === 'data') {
      if (!byteRate) return null;
      // A streamed WAV may declare a bogus size: never more than what arrived.
      return Math.min(size, b.length - pos - 8) / byteRate;
    }
    pos += 8 + size + (size % 2);
  }
  return null;
}
