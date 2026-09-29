import { observeVoiceLatency, type Logger } from '@cbi/config';
import type { Redis } from '@cbi/db';
import type { VoiceLatencyStage } from '@cbi/shared-types';

/** When a streamed answer's speech ended and when the server decided the turn was over. */
export interface SpeechEndMark {
  speechEndAt: number;
  turnEndAt: number;
}

const TTL_SEC = 15 * 60;
const key = (questionId: string) => `cbi:voice:latency:${questionId}`;

/**
 * Turn latency for realtime voice. The stream relay marks the end of the
 * candidate's speech (Redis: the next question may be generated on another
 * replica); the question speaker reports its first token and first audio
 * byte. Each stage goes to `cbi_voice_turn_latency_seconds` and the whole
 * turn is logged once. Nothing here can fail a turn.
 */
export function createVoiceLatency(deps: { redis: Redis; logger: Logger; now?: () => number }) {
  const now = deps.now ?? Date.now;

  return {
    async speechEnded(sessionId: string, questionId: string, mark: SpeechEndMark) {
      observeVoiceLatency(
        'endpoint' satisfies VoiceLatencyStage,
        mark.turnEndAt - mark.speechEndAt,
      );
      await deps.redis
        .set(key(questionId), JSON.stringify(mark), 'EX', TTL_SEC)
        .catch((err: unknown) => deps.logger.debug({ err, sessionId }, 'latency mark not stored'));
    },

    /**
     * Tracks one question's delivery. `answered` is the question the
     * candidate just answered (null for the first question) and when that
     * answer was saved.
     */
    turn(sessionId: string, answered: { questionId: string; answeredAt: Date } | null) {
      const mark: Promise<SpeechEndMark | null> = answered
        ? deps.redis
            .get(key(answered.questionId))
            .then((raw) => (raw ? (JSON.parse(raw) as SpeechEndMark) : null))
            .catch(() => null)
        : Promise.resolve(null);
      const stages: Partial<Record<VoiceLatencyStage, number>> = {};
      const observe = (stage: VoiceLatencyStage, from: number | undefined, at: number) => {
        if (from === undefined || stages[stage] !== undefined) return;
        stages[stage] = at - from;
        observeVoiceLatency(stage, at - from);
      };
      const at = async (kind: 'token' | 'audio') => {
        const t = now();
        const m = await mark;
        const answerAt = answered?.answeredAt.getTime();
        if (kind === 'token') {
          observe('answer_to_first_token', answerAt, t);
          observe('speech_to_first_token', m?.speechEndAt, t);
        } else {
          observe('answer_to_first_audio', answerAt, t);
          observe('speech_to_first_audio', m?.speechEndAt, t);
        }
      };
      let tokenSeen = false;
      let audioSeen = false;
      return {
        firstToken() {
          if (tokenSeen || !answered) return;
          tokenSeen = true;
          void at('token');
        },
        firstAudio() {
          if (audioSeen || !answered) return;
          audioSeen = true;
          void at('audio');
        },
        /** Logs the turn's stages (once the question has been delivered). */
        async done(questionId: string) {
          if (!answered) return;
          const m = await mark;
          deps.logger.info(
            {
              sessionId,
              questionId,
              answeredQuestionId: answered.questionId,
              endpointMs: m ? m.turnEndAt - m.speechEndAt : null,
              ...stages,
            },
            'voice turn latency',
          );
        },
      };
    },
  };
}

export type VoiceLatency = ReturnType<typeof createVoiceLatency>;
