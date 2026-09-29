import { voiceTurnLatency } from '@cbi/config';
import type { Redis } from '@cbi/db';
import { describe, expect, it, vi } from 'vitest';
import { createVoiceLatency } from './latency.js';

function memoryRedis() {
  const data = new Map<string, string>();
  return {
    set: vi.fn(async (key: string, value: string) => void data.set(key, value)),
    get: vi.fn(async (key: string) => data.get(key) ?? null),
  } as unknown as Redis;
}

const countOf = async (stage: string) =>
  (await voiceTurnLatency.get()).values.find(
    (v) =>
      v.labels.stage === stage && (v as { metricName?: string }).metricName?.endsWith('_count'),
  )?.value ?? 0;

describe('voice turn latency', () => {
  it('measures from the end of speech and from the answer, and logs the turn once', async () => {
    let clock = 10_000;
    const info = vi.fn();
    const latency = createVoiceLatency({
      redis: memoryRedis(),
      logger: { info, debug: vi.fn() } as never,
      now: () => clock,
    });
    const before = await countOf('speech_to_first_audio');
    await latency.speechEnded('s1', 'q1', { speechEndAt: 8_000, turnEndAt: 9_000 });
    const turn = latency.turn('s1', { questionId: 'q1', answeredAt: new Date(11_000) });
    clock = 12_200;
    turn.firstToken();
    clock = 12_900;
    turn.firstAudio();
    turn.firstAudio();
    await turn.done('q2');
    expect(info).toHaveBeenCalledOnce();
    expect(info.mock.calls[0]![0]).toEqual({
      sessionId: 's1',
      questionId: 'q2',
      answeredQuestionId: 'q1',
      endpointMs: 1_000,
      answer_to_first_token: 1_200,
      speech_to_first_token: 4_200,
      answer_to_first_audio: 1_900,
      speech_to_first_audio: 4_900,
    });
    expect(await countOf('speech_to_first_audio')).toBe(before + 1);
  });

  it('the first question has no previous answer to measure from', async () => {
    const info = vi.fn();
    const latency = createVoiceLatency({ redis: memoryRedis(), logger: { info } as never });
    const turn = latency.turn('s1', null);
    turn.firstToken();
    turn.firstAudio();
    await turn.done('q1');
    expect(info).not.toHaveBeenCalled();
  });

  it('a push-to-talk answer (no speech mark) still measures from its submission', async () => {
    const info = vi.fn();
    const latency = createVoiceLatency({
      redis: memoryRedis(),
      logger: { info } as never,
      now: () => 5_000,
    });
    const turn = latency.turn('s1', { questionId: 'q1', answeredAt: new Date(4_000) });
    turn.firstToken();
    await turn.done('q2');
    expect(info.mock.calls[0]![0]).toMatchObject({
      endpointMs: null,
      answer_to_first_token: 1_000,
    });
    expect(info.mock.calls[0]![0]).not.toHaveProperty('speech_to_first_token');
  });
});
