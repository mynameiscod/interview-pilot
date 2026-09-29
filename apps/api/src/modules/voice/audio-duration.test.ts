import { VOICE_LIMITS } from '@cbi/shared-types';
import { describe, expect, it } from 'vitest';
import { billableDurationSec, containerDurationSec } from './audio-duration.js';

// ---- Tiny container builders (just the structure the parsers read) ------------------------

const cat = (...parts: (Uint8Array | number[])[]) => Uint8Array.from(parts.flatMap((p) => [...p]));
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const le32 = (n: number) => be32(n).reverse();
const le16 = (n: number) => [n & 255, (n >>> 8) & 255];

/** EBML element: id bytes, a 1-byte size (or unknown), then the data. */
const el = (id: number[], data: number[] | Uint8Array, unknownSize = false) =>
  cat(
    id,
    unknownSize ? [0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff] : [0x80 | data.length],
    data,
  );
const block = (relMs: number) => el([0xa3], [0x81, (relMs >> 8) & 255, relMs & 255, 0x80, 1, 2, 3]);

/** What Chrome's MediaRecorder writes: no Duration, live (unknown-size) segment and clusters. */
function liveWebm(clusters: { at: number; blocks: number[] }[]) {
  return cat(
    el([0x1a, 0x45, 0xdf, 0xa3], el([0x42, 0x82], ascii('webm'))),
    [0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff],
    el([0x15, 0x49, 0xa9, 0x66], el([0x2a, 0xd7, 0xb1], [0x0f, 0x42, 0x40])),
    el([0x16, 0x54, 0xae, 0x6b], [0xae, 0x80]),
    ...clusters.map((c) =>
      cat(
        [0x1f, 0x43, 0xb6, 0x75, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff],
        el([0xe7], [(c.at >> 8) & 255, c.at & 255]),
        ...c.blocks.map(block),
      ),
    ),
  );
}

function oggPage(granule: bigint, body: number[]) {
  const g = new Uint8Array(8);
  new DataView(g.buffer).setBigInt64(0, granule, true);
  return cat(
    ascii('OggS'),
    [0, 0],
    g,
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [1, body.length],
    body,
  );
}
const opusHead = (preSkip: number) =>
  cat(ascii('OpusHead'), [1, 1], le16(preSkip), le32(48_000), [0, 0, 0]);

const box = (type: string, ...body: (Uint8Array | number[])[]) => {
  const inner = cat(...body);
  return cat(be32(inner.length + 8), ascii(type), inner);
};
const full = (version: number, flags: number) => [
  version,
  (flags >> 16) & 255,
  (flags >> 8) & 255,
  flags & 255,
];

describe('recorded answer duration', () => {
  it('reads a live MediaRecorder WebM (no Duration) from its last block', () => {
    const webm = liveWebm([
      { at: 0, blocks: [0, 20, 980] },
      { at: 1000, blocks: [0, 500, 4200] },
    ]);
    expect(containerDurationSec(webm, 'audio/webm')).toBeCloseTo(5.2, 3);
  });

  it('prefers a declared WebM Duration', () => {
    const duration = new Uint8Array(8);
    new DataView(duration.buffer).setFloat64(0, 12_345);
    const webm = cat(
      el([0x1a, 0x45, 0xdf, 0xa3], []),
      el([0x18, 0x53, 0x80, 0x67], el([0x15, 0x49, 0xa9, 0x66], el([0x44, 0x89], duration))),
    );
    expect(containerDurationSec(webm, 'audio/webm')).toBeCloseTo(12.345, 3);
  });

  it('reads Ogg Opus from the last granule position, less the pre-skip', () => {
    const ogg = cat(
      oggPage(0n, [...opusHead(312)]),
      oggPage(-1n, [1, 2, 3]),
      oggPage(48_000n * 7n + 312n, [4, 5, 6]),
    );
    expect(containerDurationSec(ogg, 'audio/ogg')).toBeCloseTo(7, 5);
  });

  it('reads MP4 from mvhd, or sums the fragments of a fragmented recording', () => {
    const mvhd = box('mvhd', full(0, 0), be32(0), be32(0), be32(1000), be32(8_500));
    expect(
      containerDurationSec(cat(box('ftyp', ascii('M4A ')), box('moov', mvhd)), 'audio/mp4'),
    ).toBe(8.5);

    // Safari's MediaRecorder: an empty moov, then moof fragments (trun with per-sample durations).
    const emptyMvhd = box('mvhd', full(0, 0), be32(0), be32(0), be32(1000), be32(0));
    const mdhd = box('mdhd', full(0, 0), be32(0), be32(0), be32(48_000), be32(0));
    const moov = box('moov', emptyMvhd, box('trak', box('mdia', mdhd)));
    const fragment = (base: number, durations: number[]) =>
      box(
        'moof',
        box(
          'traf',
          box('tfhd', full(0, 0), be32(1)),
          box('tfdt', full(0, 0), be32(base)),
          box('trun', full(0, 0x100), be32(durations.length), ...durations.map(be32)),
        ),
      );
    const mp4 = cat(
      box('ftyp', ascii('iso5')),
      moov,
      fragment(0, [48_000, 48_000]),
      fragment(96_000, [48_000, 24_000]),
    );
    expect(containerDurationSec(mp4, 'audio/mp4')).toBeCloseTo(3.5, 5);
  });

  it('reads WAV from its data size and byte rate', () => {
    const data = new Uint8Array(32_000 * 3);
    const wav = cat(
      ascii('RIFF'),
      le32(36 + data.length),
      ascii('WAVE'),
      ascii('fmt '),
      le32(16),
      le16(1),
      le16(1),
      le32(16_000),
      le32(32_000),
      le16(2),
      le16(16),
      ascii('data'),
      le32(data.length),
      data,
    );
    expect(containerDurationSec(wav, 'audio/wav')).toBe(3);
  });

  it('bills the container length, not what the browser claims', () => {
    const webm = liveWebm([{ at: 0, blocks: [0, 4000] }]);
    // The client says 5 minutes; the file holds 4 seconds.
    expect(billableDurationSec(webm, 'audio/webm', 300_000)).toBeCloseTo(4, 3);
  });

  it('bounds the client value by the byte count and the answer limit when the file cannot be read', () => {
    // 1.5 KB cannot hold more than 2 s even at Opus' lowest bitrate.
    expect(billableDurationSec(new Uint8Array(1_500), 'audio/mpeg', 300_000)).toBe(2);
    expect(billableDurationSec(new Uint8Array(1_000_000), 'audio/mpeg', 12_000)).toBe(12);
    expect(billableDurationSec(new Uint8Array(10_000_000), 'audio/mpeg', 9_999_999)).toBe(
      VOICE_LIMITS.maxAnswerSec,
    );
    // Garbage that claims to be WebM falls back rather than throwing.
    expect(
      containerDurationSec(Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 0xff]), 'audio/webm'),
    ).toBe(null);
  });
});
