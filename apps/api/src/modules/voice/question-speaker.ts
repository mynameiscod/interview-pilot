import { AiAbortedError, type AiRouter } from '@cbi/ai-core';
import type { Logger } from '@cbi/config';
import {
  RtEvent,
  type QuestionAudioEvent,
  type QuestionDeltaEvent,
  type QuestionStreamEndEvent,
} from '@cbi/shared-types';
import type { RoomEmitter } from '../live/live.service.js';
import type { VoiceLatency } from './latency.js';
import { createSentenceChunker } from './sentences.js';
import type { QuestionAudio } from './voice.service.js';

/** Receives the next question as it is generated (see live.service `advance`). */
export interface QuestionStreamSink {
  /** New question text (a preview until the question is saved). */
  delta(text: string): void;
  /**
   * The question was saved. `streamedTextIsFinal` is false when the saved
   * text differs from what was streamed (generation fell back): nothing more
   * is spoken and the room fetches the question audio as usual.
   */
  complete(streamedTextIsFinal: boolean): void;
  /** The question was not saved (the session moved on): stop everything. */
  abort(): void;
}

export interface QuestionStreamTarget {
  sessionId: string;
  userId: string;
  questionId: string;
  seq: number;
  /** TTS language hint (null: the provider detects it). */
  language: string | null;
  /** The answer this question follows, for turn latency (null for the first question). */
  answered: { questionId: string; answeredAt: Date } | null;
}

/**
 * Speaks a question while it is being written: text deltas go to the room
 * straight away; each complete sentence is synthesized with streaming TTS
 * and its audio chunks follow in order (one sentence at a time, so the
 * audio never overtakes the text). When every sentence is spoken and the
 * audio is MP3, the joined audio is stored in the question audio cache, so
 * "Repeat" costs nothing. A barge-in stops the synthesis still to come.
 */
export function createQuestionSpeaker(deps: {
  router: Pick<AiRouter, 'synthesizeStream'>;
  rooms: RoomEmitter;
  cache: { put(questionId: string, audio: QuestionAudio): Promise<void> };
  latency: Pick<VoiceLatency, 'turn'>;
  logger: Logger;
}) {
  /** Questions being spoken by this process, for barge-in. */
  const speaking = new Map<string, AbortController>();

  return {
    open(target: QuestionStreamTarget): QuestionStreamSink {
      const { sessionId, questionId, seq } = target;
      const controller = new AbortController();
      speaking.set(questionId, controller);
      const turn = deps.latency.turn(sessionId, target.answered);
      const chunker = createSentenceChunker();
      const parts: Uint8Array[] = [];
      const mimeTypes = new Set<string>();
      let sentence = 0;
      let failed = false;
      let queue: Promise<void> = Promise.resolve();
      let finished = false;

      const say = (text: string) => {
        const index = sentence++;
        queue = queue.then(async () => {
          if (failed || controller.signal.aborted) return;
          let chunk = 0;
          const pending: QuestionAudioEvent[] = [];
          const send = (e: QuestionAudioEvent) =>
            deps.rooms.emit(sessionId, RtEvent.QUESTION_AUDIO, e);
          try {
            for await (const piece of deps.router.synthesizeStream(
              { text, language: target.language },
              { userId: target.userId, sessionId, signal: controller.signal },
            )) {
              turn.firstAudio();
              parts.push(piece.audio);
              mimeTypes.add(piece.mimeType);
              // Hold one chunk back so the last one can be marked as such.
              const event: QuestionAudioEvent = {
                questionId,
                sentence: index,
                chunk: chunk++,
                mimeType: piece.mimeType,
                audio: piece.audio,
                last: false,
              };
              const previous = pending.shift();
              if (previous) send(previous);
              pending.push(event);
            }
            const lastChunk = pending.shift();
            if (lastChunk) send({ ...lastChunk, last: true });
          } catch (err) {
            if (!(err instanceof AiAbortedError)) {
              deps.logger.warn({ err, sessionId }, 'streamed question audio failed');
            }
            failed = true;
          }
        });
      };

      const end = (audio: QuestionStreamEndEvent['audio']) => {
        if (finished) return;
        finished = true;
        speaking.delete(questionId);
        deps.rooms.emit(sessionId, RtEvent.QUESTION_STREAM_END, { questionId, audio });
        void turn.done(questionId);
      };

      return {
        delta(text) {
          if (!text || finished) return;
          turn.firstToken();
          const event: QuestionDeltaEvent = { questionId, seq, text };
          deps.rooms.emit(sessionId, RtEvent.QUESTION_DELTA, event);
          for (const s of chunker.push(text)) say(s);
        },
        complete(streamedTextIsFinal) {
          if (finished) return;
          if (!streamedTextIsFinal) {
            controller.abort();
            end('none');
            return;
          }
          for (const s of chunker.flush()) say(s);
          void queue.then(async () => {
            // Interrupted (barge-in): the rest is not needed; "Repeat" fetches the whole question.
            if (controller.signal.aborted) return end('none');
            if (failed || sentence === 0) return end(sentence === 0 ? 'none' : 'failed');
            // MP3 frames join cleanly; other formats (the mock's WAV) are not cached.
            if (mimeTypes.size === 1 && mimeTypes.has('audio/mpeg')) {
              await deps.cache
                .put(questionId, { audio: Buffer.concat(parts), mimeType: 'audio/mpeg' })
                .catch((err: unknown) => deps.logger.warn({ err }, 'question audio not cached'));
            }
            end('complete');
          });
        },
        abort() {
          controller.abort();
          end('none');
        },
      };
    },

    /** The candidate interrupted the question: stop synthesizing the rest (this process only). */
    bargeIn(questionId: string) {
      speaking.get(questionId)?.abort();
    },
  };
}

export type QuestionSpeaker = ReturnType<typeof createQuestionSpeaker>;
