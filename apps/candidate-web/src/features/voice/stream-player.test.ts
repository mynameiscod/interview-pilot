import type { QuestionAudioEvent } from '@cbi/shared-types';
import { describe, expect, it, vi } from 'vitest';
import { createStreamPlayer, type AudioOutput, type StreamPlayerEvents } from './stream-player';

const chunk = (sentence: number, n: number, last = false): QuestionAudioEvent => ({
  questionId: 'q2',
  sentence,
  chunk: n,
  mimeType: 'audio/mpeg',
  audio: new Uint8Array([sentence, n]),
  last,
});

function setup() {
  const appended: [number[], number, boolean][] = [];
  let events: StreamPlayerEvents | null = null;
  const output: AudioOutput = {
    append: (c, sentence, last) => void appended.push([[...c], sentence, last]),
    finish: vi.fn(() => events?.onEnded()),
    stop: vi.fn(),
  };
  const handlers = { onStart: vi.fn(), onEnded: vi.fn(), onBlocked: vi.fn() };
  const outputFor = vi.fn((_mime: string, e: StreamPlayerEvents) => {
    events = e;
    return output;
  });
  const player = createStreamPlayer(handlers, outputFor);
  return { player, output, appended, handlers, outputFor, events: () => events! };
}

describe('stream player', () => {
  it('passes chunks to one output in order and ends when told', () => {
    const t = setup();
    t.player.push(chunk(0, 0));
    t.player.push(chunk(0, 1, true));
    t.player.push(chunk(1, 0, true));
    expect(t.outputFor).toHaveBeenCalledOnce();
    expect(t.outputFor.mock.calls[0]![0]).toBe('audio/mpeg');
    expect(t.appended).toEqual([
      [[0, 0], 0, false],
      [[0, 1], 0, true],
      [[1, 0], 1, true],
    ]);
    t.events().onStart();
    t.events().onStart();
    expect(t.handlers.onStart).toHaveBeenCalledOnce();
    t.player.end();
    expect(t.handlers.onEnded).toHaveBeenCalledOnce();
    // Nothing is accepted after the end.
    t.player.push(chunk(2, 0));
    expect(t.appended).toHaveLength(3);
  });

  it('stops at once (barge-in) and reports nothing afterwards', () => {
    const t = setup();
    t.player.push(chunk(0, 0));
    t.player.stop();
    expect(t.output.stop).toHaveBeenCalledOnce();
    t.events().onEnded();
    t.events().onStart();
    t.player.push(chunk(0, 1));
    expect(t.handlers.onEnded).not.toHaveBeenCalled();
    expect(t.handlers.onStart).not.toHaveBeenCalled();
    expect(t.appended).toHaveLength(1);
  });

  it('a stream without audio ends straight away', () => {
    const t = setup();
    t.player.end();
    expect(t.handlers.onEnded).toHaveBeenCalledOnce();
    expect(t.outputFor).not.toHaveBeenCalled();
  });
});
