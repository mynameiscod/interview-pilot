import {
  RtEvent,
  type QuestionAudioEvent,
  type QuestionDeltaEvent,
  type QuestionStreamEndEvent,
} from '@cbi/shared-types';
import { useCallback, useEffect, useRef, useState } from 'react';
import { createStreamPlayer, type StreamPlayer } from '../voice/stream-player';
import type { VoiceChannel } from './useInterviewRoom';
import { useQuestionAudio, type PlaybackStatus } from './voice-hooks';

/** A streamed question's audio: as for useQuestionAudio, or `fallback` (fetch it instead). */
type StreamStatus = PlaybackStatus | 'fallback';

/**
 * Plays questions that arrive as a stream (realtime voice): audio chunks are
 * played as they come, from the first sentence. A question whose stream
 * brought no usable audio is marked `fallback`, and one that never streamed
 * (the first question, a rejoin) is not tracked at all: both are fetched
 * whole, as before.
 */
export function useStreamedQuestionAudio(channel: VoiceChannel, enabled: boolean) {
  const [streams, setStreams] = useState<Record<string, StreamStatus>>({});
  const playerRef = useRef<{ questionId: string; player: StreamPlayer; started: boolean } | null>(
    null,
  );

  useEffect(() => {
    if (!enabled) return;
    const mark = (questionId: string, status: StreamStatus) =>
      setStreams((all) => {
        // Only recent questions matter.
        const kept = Object.fromEntries(Object.entries(all).slice(-4));
        return { ...kept, [questionId]: status };
      });
    const playerFor = (questionId: string) => {
      const current = playerRef.current;
      if (current?.questionId === questionId) return current;
      current?.player.stop();
      const entry = {
        questionId,
        started: false,
        player: createStreamPlayer({
          onStart: () => {
            entry.started = true;
            mark(questionId, 'playing');
          },
          onEnded: () => mark(questionId, 'ready'),
          onBlocked: () => mark(questionId, 'blocked'),
        }),
      };
      playerRef.current = entry;
      return entry;
    };
    const offs = [
      channel.on<QuestionDeltaEvent>(RtEvent.QUESTION_DELTA, (d) =>
        setStreams((all) => (d.questionId in all ? all : { ...all, [d.questionId]: 'loading' })),
      ),
      channel.on<QuestionAudioEvent>(RtEvent.QUESTION_AUDIO, (e) =>
        playerFor(e.questionId).player.push(e),
      ),
      channel.on<QuestionStreamEndEvent>(RtEvent.QUESTION_STREAM_END, (e) => {
        const current = playerRef.current?.questionId === e.questionId ? playerRef.current : null;
        if (current && (e.audio === 'complete' || current.started)) {
          current.player.end();
          return;
        }
        // Nothing (usable) was spoken: the whole question is fetched instead.
        current?.player.stop();
        mark(e.questionId, 'fallback');
      }),
    ];
    return () => {
      offs.forEach((off) => off());
      playerRef.current?.player.stop();
      playerRef.current = null;
    };
  }, [channel, enabled]);

  const stop = useCallback((questionId: string) => {
    const current = playerRef.current;
    if (current?.questionId !== questionId) return;
    current.player.stop();
    setStreams((all) => ({ ...all, [questionId]: 'ready' }));
  }, []);

  return { streams, stop };
}

/**
 * The interviewer's voice for the room: streamed questions play from the
 * stream, everything else (and "Repeat") uses the question audio endpoint.
 * `stop` is also the barge-in.
 */
export function useInterviewerAudio(opts: {
  sessionId: string;
  channel: VoiceChannel;
  /** The question on screen (saved), or the one being written. */
  questionId: string | null;
  realtime: boolean;
  onSpeechUnavailable: () => void;
}) {
  const { sessionId, channel, questionId, realtime, onSpeechUnavailable } = opts;
  const streamed = useStreamedQuestionAudio(channel, realtime);
  const [repeated, setRepeated] = useState<string | null>(null);
  const streamStatus = questionId ? streamed.streams[questionId] : undefined;
  const fromStream =
    realtime &&
    streamStatus !== undefined &&
    streamStatus !== 'fallback' &&
    repeated !== questionId;
  const whole = useQuestionAudio(sessionId, questionId, onSpeechUnavailable, {
    autoPlay: !(realtime && streamStatus !== undefined && streamStatus !== 'fallback'),
  });
  const { stop: stopStream } = streamed;
  const { stop: stopWhole, replay: replayWhole } = whole;
  const stop = useCallback(() => {
    if (questionId) stopStream(questionId);
    stopWhole();
  }, [questionId, stopStream, stopWhole]);
  const replay = useCallback(() => {
    if (questionId) setRepeated(questionId);
    replayWhole();
  }, [questionId, replayWhole]);
  const status: PlaybackStatus | null = fromStream
    ? (streamStatus as PlaybackStatus)
    : whole.status;
  return { status, stop, replay };
}
