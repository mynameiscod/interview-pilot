import {
  AiAbortedError,
  AiUnavailableError,
  type AiCallContext,
  type TtsRequest,
} from '@cbi/ai-core';
import {
  RtEvent,
  type QuestionAudioEvent,
  type QuestionDeltaEvent,
  type QuestionStreamEndEvent,
} from '@cbi/shared-types';
import { describe, expect, it, vi } from 'vitest';
import { createQuestionSpeaker } from './question-speaker.js';

const logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
} as unknown as Parameters<typeof createQuestionSpeaker>[0]['logger'];

/** Streaming TTS that answers each sentence with two MP3 chunks, optionally failing or waiting. */
function fakeTts(opts: { fail?: (text: string) => boolean; hold?: Promise<void> } = {}) {
  const spoken: string[] = [];
  const router = {
    synthesizeStream: vi.fn((request: TtsRequest, ctx: AiCallContext = {}) =>
      (async function* () {
        spoken.push(request.text);
        if (opts.fail?.(request.text)) throw new AiUnavailableError('tts.live', []);
        yield { audio: new Uint8Array([spoken.length, 1]), mimeType: 'audio/mpeg' };
        await opts.hold;
        if (ctx.signal?.aborted) throw new AiAbortedError('tts.live');
        yield { audio: new Uint8Array([spoken.length, 2]), mimeType: 'audio/mpeg' };
        return undefined as never;
      })(),
    ),
  };
  return { router, spoken };
}

function setup(tts = fakeTts()) {
  const emitted: { event: string; payload: unknown }[] = [];
  const cache = { put: vi.fn(async () => undefined) };
  const marks = { firstToken: vi.fn(), firstAudio: vi.fn(), done: vi.fn(async () => undefined) };
  const speaker = createQuestionSpeaker({
    router: tts.router,
    rooms: { emit: (_sessionId, event, payload) => void emitted.push({ event, payload }) },
    cache,
    latency: { turn: () => marks },
    logger,
  });
  const sink = speaker.open({
    sessionId: 's1',
    userId: 'u1',
    questionId: 'q2',
    seq: 2,
    language: 'en',
    answered: { questionId: 'q1', answeredAt: new Date() },
  });
  const events = <T>(event: string) =>
    emitted.filter((e) => e.event === event).map((e) => e.payload as T);
  const settled = () => new Promise((resolve) => setTimeout(resolve, 0));
  return { speaker, sink, cache, marks, events, settled, spoken: tts.spoken };
}

describe('question speaker', () => {
  it('streams text at once and starts speaking at the first complete sentence', async () => {
    const t = setup();
    t.sink.delta('Thanks for walking me through that migration.');
    t.sink.delta(' How did you');
    await t.settled();
    expect(t.events<QuestionDeltaEvent>(RtEvent.QUESTION_DELTA).map((d) => d.text)).toEqual([
      'Thanks for walking me through that migration.',
      ' How did you',
    ]);
    // The first sentence is being spoken while the second is still being written.
    expect(t.spoken).toEqual(['Thanks for walking me through that migration.']);
    expect(t.marks.firstToken).toHaveBeenCalled();
    expect(t.marks.firstAudio).toHaveBeenCalled();

    t.sink.delta(' roll it back safely?');
    t.sink.complete(true);
    await t.settled();
    await t.settled();
    expect(t.spoken).toEqual([
      'Thanks for walking me through that migration.',
      'How did you roll it back safely?',
    ]);
    const audio = t.events<QuestionAudioEvent>(RtEvent.QUESTION_AUDIO);
    expect(audio.map((a) => [a.sentence, a.chunk, a.last])).toEqual([
      [0, 0, false],
      [0, 1, true],
      [1, 0, false],
      [1, 1, true],
    ]);
    expect(t.events<QuestionStreamEndEvent>(RtEvent.QUESTION_STREAM_END)).toEqual([
      { questionId: 'q2', audio: 'complete' },
    ]);
    // The whole question's MP3 is cached for "Repeat".
    expect(t.cache.put).toHaveBeenCalledWith('q2', {
      audio: Buffer.from([1, 1, 1, 2, 2, 1, 2, 2]),
      mimeType: 'audio/mpeg',
    });
    expect(t.marks.done).toHaveBeenCalledWith('q2');
  });

  it('stops speaking when the saved question is not what was streamed', async () => {
    const t = setup();
    t.sink.delta('Tell me about your role.');
    t.sink.complete(false);
    await t.settled();
    expect(t.events(RtEvent.QUESTION_STREAM_END)).toEqual([{ questionId: 'q2', audio: 'none' }]);
    expect(t.cache.put).not.toHaveBeenCalled();
  });

  it('reports failed audio so the room fetches the question audio as usual', async () => {
    const t = setup(fakeTts({ fail: (text) => text.startsWith('How') }));
    t.sink.delta('Thanks for walking me through that migration. How did you roll it back?');
    t.sink.complete(true);
    await t.settled();
    await t.settled();
    expect(t.events(RtEvent.QUESTION_STREAM_END)).toEqual([{ questionId: 'q2', audio: 'failed' }]);
    expect(t.cache.put).not.toHaveBeenCalled();
  });

  it('a barge-in stops the synthesis still to come', async () => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => (release = resolve));
    const t = setup(fakeTts({ hold }));
    t.sink.delta('Thanks for walking me through that migration. How did you roll it back?');
    t.sink.complete(true);
    await t.settled();
    t.speaker.bargeIn('q2');
    release();
    await t.settled();
    await t.settled();
    expect(t.spoken).toHaveLength(1);
    expect(t.events(RtEvent.QUESTION_STREAM_END)).toEqual([{ questionId: 'q2', audio: 'none' }]);
    expect(t.cache.put).not.toHaveBeenCalled();
  });

  it('an aborted question (never saved) ends the stream without audio', () => {
    const t = setup();
    t.sink.delta('Half a quest');
    t.sink.abort();
    t.sink.delta('ion that keeps coming');
    expect(t.events(RtEvent.QUESTION_DELTA)).toHaveLength(1);
    expect(t.events(RtEvent.QUESTION_STREAM_END)).toEqual([{ questionId: 'q2', audio: 'none' }]);
  });
});
