import { createLogger } from '@cbi/config';
import type { Redis } from '@cbi/db';
import { describe, expect, it, vi } from 'vitest';
import { createQuestionAudioCache, sniffAudio, type QuestionAudio } from './voice.service.js';

const bytes = (...parts: (string | number[])[]) =>
  new Uint8Array(
    parts.flatMap((p) => (typeof p === 'string' ? [...p].map((c) => c.charCodeAt(0)) : p)),
  );

describe('sniffAudio', () => {
  it('recognises the containers browsers record and common audio files', () => {
    expect(sniffAudio(bytes([0x1a, 0x45, 0xdf, 0xa3], 'webm'))).toBe('audio/webm');
    expect(sniffAudio(bytes('OggS', [0, 2]))).toBe('audio/ogg');
    expect(sniffAudio(bytes('RIFF', [0, 0, 0, 0], 'WAVE'))).toBe('audio/wav');
    expect(sniffAudio(bytes([0, 0, 0, 0x20], 'ftypM4A '))).toBe('audio/mp4');
    expect(sniffAudio(bytes('ID3', [4, 0]))).toBe('audio/mpeg');
    expect(sniffAudio(bytes([0xff, 0xfb, 0x90]))).toBe('audio/mpeg');
  });

  it('rejects anything else, whatever it claims to be', () => {
    expect(sniffAudio(bytes('%PDF-1.7'))).toBeNull();
    expect(sniffAudio(bytes('<html>'))).toBeNull();
    expect(sniffAudio(new Uint8Array())).toBeNull();
  });
});

/** The Redis commands the question audio cache uses, shared by every "replica" in a test. */
function fakeRedis(opts: { down?: boolean } = {}) {
  const values = new Map<string, Buffer | string>();
  const check = () => {
    if (opts.down) throw new Error('redis down');
  };
  const redis = {
    async getBuffer(key: string) {
      check();
      const v = values.get(key);
      return v === undefined ? null : Buffer.from(v);
    },
    async get(key: string) {
      check();
      const v = values.get(key);
      return v === undefined ? null : String(v);
    },
    async set(key: string, value: string, ...args: (string | number)[]) {
      check();
      if (args.includes('NX') && values.has(key)) return null;
      values.set(key, value);
      return 'OK';
    },
    async exists(key: string) {
      check();
      return values.has(key) ? 1 : 0;
    },
    async eval(_script: string, _n: number, key: string, token: string) {
      check();
      if (values.get(key) !== token) return 0;
      values.delete(key);
      return 1;
    },
    multi() {
      const ops: [string, Buffer | string][] = [];
      const chain = {
        set(key: string, value: Buffer | string) {
          ops.push([key, value]);
          return chain;
        },
        async exec() {
          check();
          for (const [k, v] of ops) values.set(k, v);
          return [];
        },
      };
      return chain;
    },
  };
  return { redis: redis as unknown as Redis, values };
}

const logger = createLogger({ service: 'test', level: 'silent' });
const spoken: QuestionAudio = { audio: Buffer.from('mp3-bytes'), mimeType: 'audio/mpeg' };

/** A synthesis the test finishes (or fails) when it wants. */
function slowSynthesis() {
  let finish!: (fail?: Error) => void;
  const synth = vi.fn(
    () =>
      new Promise<QuestionAudio>((resolve, reject) => {
        finish = (fail) => (fail ? reject(fail) : resolve(spoken));
      }),
  );
  return { synth, finish: (fail?: Error) => finish(fail) };
}

describe('question audio across API replicas', () => {
  it('synthesizes a question once: the other replica waits and reads the cache', async () => {
    const { redis, values } = fakeRedis();
    const replicaA = createQuestionAudioCache({ redis, logger, pollMs: 5 });
    const replicaB = createQuestionAudioCache({ redis, logger, pollMs: 5 });
    const a = slowSynthesis();
    const b = slowSynthesis();

    const first = replicaA.get('q1', a.synth);
    await vi.waitFor(() => expect(a.synth).toHaveBeenCalled());
    const second = replicaB.get('q1', b.synth);
    await new Promise((r) => setTimeout(r, 30));
    a.finish();

    expect(await first).toEqual(spoken);
    expect(await second).toEqual(spoken);
    expect(b.synth).not.toHaveBeenCalled();
    // The lock is released; the audio stays cached.
    expect(values.has('cbi:voice:tts-lock:q1')).toBe(false);
    expect(values.get('cbi:voice:tts:q1:type')).toBe('audio/mpeg');
    const c = slowSynthesis();
    expect(await replicaB.get('q1', c.synth)).toEqual(spoken);
    expect(c.synth).not.toHaveBeenCalled();
  });

  it('lets a waiting replica synthesize when the holder fails', async () => {
    const { redis } = fakeRedis();
    const replicaA = createQuestionAudioCache({ redis, logger, pollMs: 5 });
    const replicaB = createQuestionAudioCache({ redis, logger, pollMs: 5 });
    const a = slowSynthesis();
    const b = vi.fn(async () => spoken);

    const first = replicaA.get('q2', a.synth);
    await vi.waitFor(() => expect(a.synth).toHaveBeenCalled());
    const second = replicaB.get('q2', b);
    await new Promise((r) => setTimeout(r, 20));
    a.finish(new Error('TTS unavailable'));

    await expect(first).rejects.toThrow('TTS unavailable');
    expect(await second).toEqual(spoken);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('stops waiting after the lock lifetime and synthesizes itself', async () => {
    const { redis, values } = fakeRedis();
    // A crashed holder's lock that has not expired yet.
    values.set('cbi:voice:tts-lock:q3', 'someone-else');
    const cache = createQuestionAudioCache({ redis, logger, pollMs: 5, lockMs: 40 });
    const synth = vi.fn(async () => spoken);
    expect(await cache.get('q3', synth)).toEqual(spoken);
    expect(synth).toHaveBeenCalledTimes(1);
  });

  it('still speaks the question when Redis is down', async () => {
    const { redis } = fakeRedis({ down: true });
    const cache = createQuestionAudioCache({ redis, logger, pollMs: 5 });
    const synth = vi.fn(async () => spoken);
    expect(await cache.get('q4', synth)).toEqual(spoken);
    expect(synth).toHaveBeenCalledTimes(1);
  });
});
